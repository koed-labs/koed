import type { CollaborationRepository } from "@koed/db";

interface CollaborationReplayPruneLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface CollaborationReplayPruneService {
  start(): void;
  stop(): void;
  processOnce(): Promise<{
    deletedEventCount: number;
    deletedSubscriptionCount: number;
  }>;
}

export const createCollaborationReplayPruneService = (options: {
  repository: Pick<CollaborationRepository, "pruneExpiredReplayHistory">;
  logger: CollaborationReplayPruneLogger;
  intervalMs?: number;
  batchLimit?: number;
}): CollaborationReplayPruneService => {
  const intervalMs = Math.max(options.intervalMs ?? 60_000, 1_000);
  const batchLimit = Math.max(1, Math.min(options.batchLimit ?? 1_000, 10_000));
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let processing: Promise<void> | null = null;

  const processOnce: CollaborationReplayPruneService["processOnce"] =
    async () => {
      const result = await options.repository.pruneExpiredReplayHistory({
        limit: batchLimit
      });
      if (result.deletedEventCount > 0 || result.deletedSubscriptionCount > 0) {
        options.logger.info(
          {
            event: {
              name: "collaboration.replay_history.pruned",
              category: "retention"
            },
            deletedEventCount: result.deletedEventCount,
            deletedSubscriptionCount: result.deletedSubscriptionCount
          },
          "expired collaboration replay history pruned"
        );
      }
      return result;
    };

  const schedule = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      processing = processOnce()
        .then(() => undefined)
        .catch((error: unknown) => {
          options.logger.error(
            {
              event: {
                name: "collaboration.replay_history.prune_failed",
                category: "retention"
              },
              errorClass:
                error instanceof Error ? error.name : "UnknownPruneError"
            },
            "collaboration replay history prune failed"
          );
        })
        .finally(() => {
          processing = null;
          if (!stopped) {
            timer = setTimeout(() => {
              timer = null;
              schedule();
            }, intervalMs);
            timer.unref?.();
          }
        });
    }, 0);
    timer.unref?.();
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      void processing;
    },
    processOnce
  };
};
