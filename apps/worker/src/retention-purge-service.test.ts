import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedPurgeJob, RetentionLifecycleRepository } from "@koed/db";
import { createRetentionPurgeService } from "./retention-purge-service.js";

const claimed = {
  job: { id: "11111111-1111-4111-8111-111111111111" },
  attempt: {
    id: "22222222-2222-4222-8222-222222222222",
    attemptNumber: 1
  },
  requiredArtifacts: []
} as unknown as ClaimedPurgeJob;

const artifactFailure = (
  artifactKind: "wrapped_key",
  artifactLocatorHash: string,
  cause: Error
): Error & { artifactKind: "wrapped_key"; artifactLocatorHash: string } =>
  Object.assign(new Error("Purge artifact processing failed", { cause }), {
    name: "PurgeArtifactProcessingError",
    artifactKind,
    artifactLocatorHash
  });

const fixture = (options?: { maxAttempts?: number }) => {
  const repository = {
    claimNextPurgeJob: vi.fn(),
    processClaimedPurgeJob: vi.fn(),
    completePurgeJob: vi.fn(),
    recordPurgeEvidence: vi.fn(),
    finishPurgeAttempt: vi.fn()
  } as unknown as RetentionLifecycleRepository;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
  return {
    logger,
    repository,
    service: createRetentionPurgeService({
      repository,
      logger,
      intervalMs: 250,
      maxAttempts: options?.maxAttempts,
      now: () => new Date("2026-07-18T00:00:00.000Z")
    })
  };
};

describe("retention purge service", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does no work when no purge job is due", async () => {
    const test = fixture();
    vi.mocked(test.repository.claimNextPurgeJob).mockResolvedValue(null);

    await expect(test.service.processOnce()).resolves.toEqual({
      claimed: false,
      completion: null
    });
    expect(test.repository.processClaimedPurgeJob).not.toHaveBeenCalled();
  });

  it("processes and verifies one claimed purge job", async () => {
    const test = fixture();
    vi.mocked(test.repository.claimNextPurgeJob).mockResolvedValue(claimed);
    vi.mocked(test.repository.processClaimedPurgeJob).mockResolvedValue(
      claimed.job
    );
    vi.mocked(test.repository.completePurgeJob).mockResolvedValue({
      completed: true,
      job: claimed.job
    });

    await expect(test.service.processOnce()).resolves.toMatchObject({
      claimed: true,
      completion: { completed: true }
    });
    expect(test.repository.processClaimedPurgeJob).toHaveBeenCalledWith({
      purgeJobId: claimed.job.id,
      purgeAttemptId: claimed.attempt.id
    });
    expect(test.repository.completePurgeJob).toHaveBeenCalledWith(
      claimed.job.id
    );
  });

  it("waits for the configured interval while the purge queue is empty", async () => {
    vi.useFakeTimers();
    const test = fixture();
    vi.mocked(test.repository.claimNextPurgeJob).mockResolvedValue(null);

    test.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.repository.claimNextPurgeJob).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(test.repository.claimNextPurgeJob).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(test.repository.claimNextPurgeJob).toHaveBeenCalledTimes(2);
    test.service.stop();
  });

  it("drains claimed purge jobs before applying the idle interval", async () => {
    vi.useFakeTimers();
    const test = fixture();
    vi.mocked(test.repository.claimNextPurgeJob)
      .mockResolvedValueOnce(claimed)
      .mockResolvedValue(null);
    vi.mocked(test.repository.processClaimedPurgeJob).mockResolvedValue(
      claimed.job
    );
    vi.mocked(test.repository.completePurgeJob).mockResolvedValue({
      completed: true,
      job: claimed.job
    });

    test.service.start();
    await vi.advanceTimersToNextTimerAsync();
    expect(test.repository.claimNextPurgeJob).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(249);
    expect(test.repository.claimNextPurgeJob).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(test.repository.claimNextPurgeJob).toHaveBeenCalledTimes(3);
    test.service.stop();
  });

  it("backs off after a purge claim failure", async () => {
    vi.useFakeTimers();
    const test = fixture();
    vi.mocked(test.repository.claimNextPurgeJob)
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(null);

    test.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.repository.claimNextPurgeJob).toHaveBeenCalledTimes(1);
    expect(test.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: {
          name: "retention.purge.loop_failed",
          category: "retention"
        }
      }),
      "retention purge loop failed"
    );

    await vi.advanceTimersByTimeAsync(249);
    expect(test.repository.claimNextPurgeJob).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(test.repository.claimNextPurgeJob).toHaveBeenCalledTimes(2);
    test.service.stop();
  });

  it("records a bounded retry without logging purge payload details", async () => {
    const test = fixture();
    const sensitive = "private customer deletion detail";
    vi.mocked(test.repository.claimNextPurgeJob).mockResolvedValue(claimed);
    vi.mocked(test.repository.processClaimedPurgeJob).mockRejectedValue(
      new Error(sensitive)
    );
    vi.mocked(test.repository.finishPurgeAttempt).mockResolvedValue(
      claimed.job
    );

    await expect(test.service.processOnce()).resolves.toEqual({
      claimed: true,
      completion: null
    });
    expect(test.repository.finishPurgeAttempt).toHaveBeenCalledWith({
      purgeJobId: claimed.job.id,
      purgeAttemptId: claimed.attempt.id,
      outcome: "retryable_failure",
      errorCode: "Error",
      errorHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      retryAt: new Date("2026-07-18T00:00:00.250Z")
    });
    expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain(
      sensitive
    );
  });

  it("records the failed artifact checkpoint and stops at a bounded terminal attempt", async () => {
    const test = fixture({ maxAttempts: 3 });
    const locatorHash = "a".repeat(64);
    const terminalClaim = {
      ...claimed,
      job: { ...claimed.job, attemptCount: 3 },
      attempt: {
        ...claimed.attempt,
        attemptNumber: 3,
        startedAt: new Date("2026-07-18T00:00:00.000Z")
      },
      requiredArtifacts: [
        {
          artifactKind: "wrapped_key",
          artifactLocatorHash: locatorHash,
          state: "failed"
        }
      ]
    } as unknown as ClaimedPurgeJob;
    vi.mocked(test.repository.claimNextPurgeJob).mockResolvedValue(
      terminalClaim
    );
    vi.mocked(test.repository.processClaimedPurgeJob).mockRejectedValue(
      artifactFailure(
        "wrapped_key",
        locatorHash,
        new Error("private key-provider detail")
      )
    );
    vi.mocked(test.repository.recordPurgeEvidence).mockResolvedValue(
      terminalClaim.requiredArtifacts[0]!
    );
    vi.mocked(test.repository.finishPurgeAttempt).mockResolvedValue(
      terminalClaim.job
    );

    await expect(test.service.processOnce()).resolves.toEqual({
      claimed: true,
      completion: null
    });
    expect(test.repository.recordPurgeEvidence).toHaveBeenCalledWith({
      purgeJobId: terminalClaim.job.id,
      purgeAttemptId: terminalClaim.attempt.id,
      artifactKind: "wrapped_key",
      artifactLocatorHash: locatorHash,
      state: "failed",
      removedRecordCount: 0,
      removedByteCount: 0,
      observedAt: new Date("2026-07-18T00:00:00.000Z")
    });
    expect(test.repository.finishPurgeAttempt).toHaveBeenCalledWith({
      purgeJobId: terminalClaim.job.id,
      purgeAttemptId: terminalClaim.attempt.id,
      outcome: "terminal_failure",
      resumeArtifactKind: "wrapped_key",
      resumeCursor: locatorHash,
      errorCode: "PurgeArtifactProcessingError",
      errorHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(JSON.stringify(test.logger.error.mock.calls)).not.toContain(
      "private key-provider detail"
    );
    expect(test.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: {
          name: "retention.purge.attempt_started",
          category: "retention"
        },
        attemptNumber: 3,
        completedArtifactCount: 0,
        requiredArtifactCount: 1,
        nextArtifactKind: "wrapped_key"
      }),
      "retention purge attempt started"
    );
    expect(test.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: {
          name: "retention.purge.terminal_failure",
          category: "retention"
        },
        attemptNumber: 3,
        artifactKind: "wrapped_key"
      }),
      "retention purge reached terminal failure"
    );
  });
});
