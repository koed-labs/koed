import type { EmbeddingWorkflow } from "./embedding-workflow.js";
import {
  createNotificationDrainController,
  type NotificationDrainPool
} from "./notification-drain-controller.js";

const WAKE_CHANNEL = "koed_collaboration_realtime";

interface SharedMemoryEmbeddingLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface SharedMemoryEmbeddingService {
  start(): void;
  stop(): Promise<void>;
  processOnce(): Promise<{
    processed: number;
    embedded: number;
    failed: number;
  }>;
}

export const createSharedMemoryEmbeddingService = (options: {
  embeddingWorkflow: Pick<
    EmbeddingWorkflow,
    | "reconcileSharedMemorySemanticItems"
    | "getNextSharedMemorySemanticEmbeddingRetryAt"
  >;
  wakePool: NotificationDrainPool;
  logger: SharedMemoryEmbeddingLogger;
  batchLimit?: number;
  reconnectBaseMs?: number;
}): SharedMemoryEmbeddingService => {
  const batchLimit = Math.max(1, Math.min(options.batchLimit ?? 32, 128));

  const processOnce = async () => {
    const result =
      await options.embeddingWorkflow.reconcileSharedMemorySemanticItems({
        limit: batchLimit
      });
    controller.scheduleRetry(
      await options.embeddingWorkflow.getNextSharedMemorySemanticEmbeddingRetryAt()
    );
    return result;
  };

  const controller = createNotificationDrainController({
    channels: [WAKE_CHANNEL],
    wakePool: options.wakePool,
    processOnce,
    reconnectBaseMs: options.reconnectBaseMs,
    shouldContinue: (result) => result.processed === batchLimit,
    onProcessed(result) {
      if (result.processed > 0) {
        options.logger.info(
          {
            event: {
              name: "shared_memory.semantic_embeddings.reconciled",
              category: "embedding"
            },
            ...result
          },
          "Shared Memory semantic embeddings reconciled"
        );
      }
    },
    onProcessError(error) {
      options.logger.error(
        {
          event: {
            name: "shared_memory.semantic_embeddings.failed",
            category: "embedding"
          },
          errorClass: error instanceof Error ? error.name : "UnknownError"
        },
        "Shared Memory semantic embedding reconciliation failed"
      );
    }
  });

  return {
    start: controller.start,
    stop: controller.stop,
    processOnce
  };
};
