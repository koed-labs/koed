import type { ProjectSourceRepository } from "@koed/db";
import { extractProjectSourceTextBounded } from "@koed/worker/project-source-extractor-client";
import { ProjectSourceExtractionError } from "@koed/worker/project-source-extraction-contract";

export const createProjectSourceIngestionService = (input: {
  repository: ProjectSourceRepository;
  projectNote: (value: {
    ownerUserId: string;
    note: Awaited<
      ReturnType<ProjectSourceRepository["completeDocumentAttempt"]>
    >["note"];
  }) => Promise<void>;
  onError?: (error: unknown) => void;
  intervalMs?: number;
}) => {
  let running: Promise<void> | null = null;
  let stopped = false;
  const drain = async () => {
    for (let count = 0; count < 10 && !stopped; count++) {
      const claimed = await input.repository.claimDocumentAttempt();
      if (!claimed) return;
      let text: string;
      try {
        text = await extractProjectSourceTextBounded({
          name: claimed.name,
          bytes: claimed.bytes
        });
      } catch (error) {
        const reason =
          error instanceof ProjectSourceExtractionError
            ? error.reason
            : "parse_error";
        await input.repository.finishDocumentAttempt({
          ownerUserId: claimed.ownerUserId,
          attemptId: claimed.id,
          leaseGeneration: claimed.leaseGeneration,
          failureReason: reason
        });
        continue;
      }
      const completed = await input.repository.completeDocumentAttempt({
        ownerUserId: claimed.ownerUserId,
        attemptId: claimed.id,
        leaseGeneration: claimed.leaseGeneration,
        text
      });
      // Retry the idempotent Note projection even when its event is already
      // available: a crash may have occurred after marking it available but
      // before the embedding enqueue was acknowledged.
      await input.projectNote({
        ownerUserId: claimed.ownerUserId,
        note: completed.note
      });
      await input.repository.finishDocumentAttempt({
        ownerUserId: claimed.ownerUserId,
        attemptId: claimed.id,
        leaseGeneration: claimed.leaseGeneration
      });
    }
  };
  const runNow = () => {
    if (!running && !stopped)
      running = drain()
        .catch((error) => input.onError?.(error))
        .finally(() => {
          running = null;
        });
    return running ?? Promise.resolve();
  };
  const timer = setInterval(() => void runNow(), input.intervalMs ?? 5_000);
  timer.unref();
  void runNow();
  return {
    runNow,
    async close() {
      stopped = true;
      clearInterval(timer);
      await running;
    }
  };
};
