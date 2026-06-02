import { scheduleCompaction, type Visibility } from "@koed/core";
import type { MemorySourceRepository } from "@koed/db";
import type { Logger } from "pino";
import type { EmbeddingWorkflow } from "./embedding-workflow.js";

export interface RawProjectionServiceConfig {
  actorLimit: number;
  batchLimit: number;
  embeddingWorkflow: EmbeddingWorkflow;
  enqueueLcmNodeEmbeddings(nodeIds: string[]): Promise<unknown[]>;
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
      for (const actor of actors) {
        const result = await config.repository.projectPendingConversationItems(
          actor,
          {
            limit: config.batchLimit
          }
        );
        await Promise.all(
          result.memoryEventIds.map((eventId) =>
            config.embeddingWorkflow.embedSource("memory_event", eventId)
          )
        );
        const scopes = new Map<string, { visibility: Visibility }>();
        for (const scope of result.memoryEventScopes) {
          scopes.set(scope.visibility, { visibility: scope.visibility });
        }
        for (const scope of scopes.values()) {
          const compaction = await scheduleCompaction({
            repository: config.repository,
            requesterContext: actor,
            visibility: scope.visibility
          });
          const nodeIds = [
            ...compaction.leafNodeIds,
            ...(compaction.rollupNodeId ? [compaction.rollupNodeId] : [])
          ];
          await config.enqueueLcmNodeEmbeddings(nodeIds);
        }
        scanned += result.rawItemsScanned;
        projected += result.rawItemsProjected;
      }
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
              projected
            }
          },
          "raw conversation projection catch-up completed"
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
