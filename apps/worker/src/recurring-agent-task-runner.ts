import { randomUUID } from "node:crypto";

import type { RecurringAgentOccurrence } from "@koed/shared";
import type { Logger } from "pino";

import type { RecurringAgentTaskRunnerAuthority } from "./managed-conversation-authority-client.js";

export interface RecurringAgentTaskRunner {
  start(): void;
  processOnce(): Promise<void>;
  stop(): Promise<void>;
}

/** Polls the selected API authority; reservation and native submission stay there. */
export const createRecurringAgentTaskRunner = (options: {
  authority: RecurringAgentTaskRunnerAuthority;
  logger: Logger;
  runnerId?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
}): RecurringAgentTaskRunner => {
  const runnerId = options.runnerId ?? `recurring-agent-task:${randomUUID()}`;
  const pollIntervalMs = options.pollIntervalMs ?? 25_000;
  const leaseMs = options.leaseMs ?? 120_000;
  let stopped = false;
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const report = (error: unknown): void => {
    options.logger.warn(
      {
        event: {
          name: "worker.recurring_agent_task.poll_failed",
          category: "recurring_agent_task"
        },
        error_name:
          error instanceof Error ? error.name : "RecurringAgentTaskRunnerError"
      },
      "Recurring Agent task polling deferred"
    );
  };

  const processOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    const current = (async () => {
      try {
        const occurrence: RecurringAgentOccurrence | null =
          await options.authority.claimNext({ runnerId, leaseMs });
        if (occurrence) {
          options.logger.info(
            {
              event: {
                name: "worker.recurring_agent_task.submitted",
                category: "recurring_agent_task"
              },
              occurrence_id: occurrence.id,
              occurrence_status: occurrence.status
            },
            "Recurring Agent task occurrence submitted to native chat"
          );
        }
      } catch (error) {
        report(error);
      }
    })();
    const wrapped = current.finally(() => {
      if (running === wrapped) running = null;
    });
    running = wrapped;
    return wrapped;
  };

  return {
    start() {
      if (stopped || timer) return;
      void processOnce();
      timer = setInterval(() => void processOnce(), pollIntervalMs);
      timer.unref?.();
    },
    processOnce,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    }
  };
};
