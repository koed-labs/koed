import type { EmbeddingWorkflow } from "./embedding-workflow.js";

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
    "reconcileSharedMemorySemanticItems"
  >;
  logger: SharedMemoryEmbeddingLogger;
  intervalMs?: number;
  batchLimit?: number;
}): SharedMemoryEmbeddingService => {
  const intervalMs = Math.max(options.intervalMs ?? 5_000, 1_000);
  const batchLimit = Math.max(1, Math.min(options.batchLimit ?? 32, 128));
  let stopped = true;
  let timer: NodeJS.Timeout | null = null;
  let processing: Promise<void> | null = null;

  const processOnce = () =>
    options.embeddingWorkflow.reconcileSharedMemorySemanticItems({
      limit: batchLimit
    });

  const schedule = (delayMs: number): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      processing = processOnce()
        .then((result) => {
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
        })
        .catch((error: unknown) => {
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
        })
        .finally(() => {
          processing = null;
          schedule(intervalMs);
        });
    }, delayMs);
    timer.unref?.();
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await processing;
    },
    processOnce
  };
};
