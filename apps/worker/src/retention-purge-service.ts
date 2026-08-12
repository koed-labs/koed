import { createHash } from "node:crypto";
import type {
  PurgeArtifactKind,
  PurgeCompletionResult,
  RetentionLifecycleRepository
} from "@koed/db";

interface RetentionPurgeLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface RetentionPurgeService {
  start(): void;
  stop(): void;
  processOnce(): Promise<{
    claimed: boolean;
    completion: PurgeCompletionResult | null;
  }>;
}

const errorCode = (error: unknown): string =>
  error instanceof Error && error.name
    ? error.name.slice(0, 120)
    : "UnknownPurgeError";

const errorHash = (error: unknown): string =>
  createHash("sha256")
    .update(
      error instanceof Error
        ? `${error.name}:${error.message}`
        : "UnknownPurgeError"
    )
    .digest("hex");

const purgeArtifactKinds = new Set<PurgeArtifactKind>([
  "database_row",
  "encrypted_payload",
  "wrapped_key",
  "search_index",
  "vector",
  "outbox_replay",
  "backup_copy"
]);

const asArtifactFailure = (
  error: unknown
): { artifactKind: PurgeArtifactKind; artifactLocatorHash: string } | null => {
  if (
    !error ||
    typeof error !== "object" ||
    !("name" in error) ||
    error.name !== "PurgeArtifactProcessingError" ||
    !("artifactKind" in error) ||
    typeof error.artifactKind !== "string" ||
    !purgeArtifactKinds.has(error.artifactKind as PurgeArtifactKind) ||
    !("artifactLocatorHash" in error) ||
    typeof error.artifactLocatorHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(error.artifactLocatorHash)
  ) {
    return null;
  }
  return {
    artifactKind: error.artifactKind as PurgeArtifactKind,
    artifactLocatorHash: error.artifactLocatorHash
  };
};

export const createRetentionPurgeService = (options: {
  repository: RetentionLifecycleRepository;
  logger: RetentionPurgeLogger;
  intervalMs?: number;
  maxAttempts?: number;
  now?: () => Date;
}): RetentionPurgeService => {
  const intervalMs = Math.max(options.intervalMs ?? 1_000, 250);
  const maxAttempts = Math.max(options.maxAttempts ?? 5, 1);
  const now = options.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let processing: Promise<void> | null = null;

  const processOnce: RetentionPurgeService["processOnce"] = async () => {
    const claimed = await options.repository.claimNextPurgeJob();
    if (!claimed) return { claimed: false, completion: null };

    const terminalEvidenceStates = new Set([
      "verified",
      "not_applicable",
      "scheduled_expiry"
    ]);
    options.logger.info(
      {
        event: {
          name: "retention.purge.attempt_started",
          category: "retention"
        },
        purgeJobId: claimed.job.id,
        attemptNumber: claimed.attempt.attemptNumber,
        completedArtifactCount: claimed.requiredArtifacts.filter((artifact) =>
          terminalEvidenceStates.has(artifact.state)
        ).length,
        requiredArtifactCount: claimed.requiredArtifacts.length,
        nextArtifactKind: claimed.requiredArtifacts.find(
          (artifact) => !terminalEvidenceStates.has(artifact.state)
        )?.artifactKind
      },
      "retention purge attempt started"
    );

    try {
      await options.repository.processClaimedPurgeJob({
        purgeJobId: claimed.job.id,
        purgeAttemptId: claimed.attempt.id
      });
      const completion = await options.repository.completePurgeJob(
        claimed.job.id
      );
      options.logger.info(
        {
          event: {
            name: completion.completed
              ? "retention.purge.completed"
              : "retention.purge.awaiting_completion",
            category: "retention"
          },
          purgeJobId: claimed.job.id,
          ...(completion.completed ? {} : { reason: completion.reason })
        },
        completion.completed
          ? "retention purge completed"
          : "retention purge is awaiting completion"
      );
      return { claimed: true, completion };
    } catch (error) {
      const code = errorCode(error);
      const failedAt = now();
      const artifactFailure = asArtifactFailure(error);
      if (artifactFailure) {
        await options.repository.recordPurgeEvidence({
          purgeJobId: claimed.job.id,
          purgeAttemptId: claimed.attempt.id,
          artifactKind: artifactFailure.artifactKind,
          artifactLocatorHash: artifactFailure.artifactLocatorHash,
          state: "failed",
          removedRecordCount: 0,
          removedByteCount: 0,
          observedAt: failedAt
        });
      }
      const terminal = claimed.attempt.attemptNumber >= maxAttempts;
      await options.repository.finishPurgeAttempt({
        purgeJobId: claimed.job.id,
        purgeAttemptId: claimed.attempt.id,
        outcome: terminal ? "terminal_failure" : "retryable_failure",
        ...(artifactFailure
          ? {
              resumeArtifactKind: artifactFailure.artifactKind,
              resumeCursor: artifactFailure.artifactLocatorHash
            }
          : {}),
        errorCode: code,
        errorHash: errorHash(error),
        ...(terminal
          ? {}
          : { retryAt: new Date(failedAt.getTime() + intervalMs) })
      });
      options.logger.error(
        {
          event: {
            name: terminal
              ? "retention.purge.terminal_failure"
              : "retention.purge.retry_scheduled",
            category: "retention"
          },
          purgeJobId: claimed.job.id,
          attemptNumber: claimed.attempt.attemptNumber,
          errorClass: code,
          ...(artifactFailure
            ? { artifactKind: artifactFailure.artifactKind }
            : {})
        },
        terminal
          ? "retention purge reached terminal failure"
          : "retention purge retry scheduled"
      );
      return { claimed: true, completion: null };
    }
  };

  const schedule = (delayMs = 0): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      let nextDelayMs = intervalMs;
      processing = processOnce()
        .then((result) => {
          if (result.claimed) nextDelayMs = 0;
        })
        .catch((error: unknown) => {
          options.logger.error(
            {
              event: {
                name: "retention.purge.loop_failed",
                category: "retention"
              },
              errorClass: errorCode(error)
            },
            "retention purge loop failed"
          );
        })
        .finally(() => {
          processing = null;
          schedule(nextDelayMs);
        });
    }, delayMs);
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
