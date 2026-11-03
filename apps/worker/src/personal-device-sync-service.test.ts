import { describe, expect, it, vi } from "vitest";
import type { MemorySourceRepository } from "@koed/db";
import type { Logger } from "pino";
import {
  createPdsLocalSyncService,
  type PdsWorkerSecureRuntime
} from "./personal-device-sync-service.js";

describe("Personal Device Sync service", () => {
  const wakePool = {
    connect: vi.fn().mockRejectedValue(new Error("not used by run"))
  };
  const logger = { warn: vi.fn() } as unknown as Logger;

  it("reconciles and acknowledges Project configuration without source materialization", async () => {
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      receivePdsInbox: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([
        {
          id: "inbox",
          groupId: "group",
          packageId: "package",
          sourceManifestHash: "hash",
          attemptCount: 1
        }
      ]),
      completePdsInbox: vi.fn().mockResolvedValue(true),
      materializePdsReplica: vi.fn(),
      markPdsInboxFailure: vi.fn()
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      reconcileProjectSelections: vi.fn().mockResolvedValue(1),
      poll: vi.fn().mockResolvedValue([]),
      publish: vi.fn(),
      outboundState: vi.fn(),
      acknowledge: vi.fn().mockResolvedValue(undefined),
      materialize: vi.fn().mockResolvedValue({
        kind: "project_selection",
        userId: "owner",
        originDeviceId: "origin"
      })
    } as PdsWorkerSecureRuntime;
    await createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool,
      logger,
      workerId: "worker"
    }).run();
    expect(secureRuntime.reconcileProjectSelections).toHaveBeenCalledOnce();
    expect(secureRuntime.acknowledge).toHaveBeenCalledWith({
      inboxId: "inbox",
      groupId: "group",
      packageId: "package",
      sourceManifestHash: "hash",
      originDeviceId: "origin"
    });
    expect(repository.completePdsInbox).toHaveBeenCalledWith({
      workerId: "worker",
      inboxId: "inbox",
      verifiedNonSource: true,
      state: "ready"
    });
    expect(repository.materializePdsReplica).not.toHaveBeenCalled();
    expect(repository.markPdsInboxFailure).not.toHaveBeenCalled();
  });

  it("publishes checkpoints after an inbound poll rejection and logs the failure", async () => {
    const pollError = new Error("relay unavailable");
    const failureLogger = { warn: vi.fn() } as unknown as Logger;
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn().mockResolvedValue([
        {
          id: "outbox",
          groupId: "group",
          closureId: "closure",
          packageId: "package",
          sourceManifestHash: "hash",
          attemptCount: 1
        }
      ]),
      beginPdsOutboxNetworkAction: vi.fn().mockResolvedValue(true),
      completePdsOutbox: vi.fn().mockResolvedValue(undefined)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi.fn().mockResolvedValue(undefined),
      reconcilePersonalConfiguration: vi.fn().mockResolvedValue(0),
      reconcileProjectSelections: vi.fn().mockResolvedValue(0),
      reconcileArtifacts: vi.fn().mockResolvedValue(0),
      poll: vi.fn().mockRejectedValue(pollError),
      publish: vi
        .fn()
        .mockResolvedValue({ state: "committed", transportId: "transport" }),
      outboundState: vi.fn(),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;

    await createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool,
      logger: failureLogger,
      workerId: "worker"
    }).run();

    expect(repository.completePdsOutbox).toHaveBeenCalledWith({
      workerId: "worker",
      outboxId: "outbox",
      state: "committed",
      transportId: "transport"
    });
    expect(secureRuntime.poll).toHaveBeenCalledOnce();
    expect(
      vi.mocked(secureRuntime.reconcileArtifacts!).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(secureRuntime.poll).mock.invocationCallOrder[0]!);
    expect(
      vi.mocked(secureRuntime.poll).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(secureRuntime.publish).mock.invocationCallOrder[0]!
    );
    expect(failureLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: pollError }),
      expect.any(String)
    );
    expect(
      vi.mocked(secureRuntime.pollLifecycle!).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(secureRuntime.publish).mock.invocationCallOrder[0]!
    );
    expect(
      vi.mocked(secureRuntime.reconcilePersonalConfiguration!).mock
        .invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(secureRuntime.publish).mock.invocationCallOrder[0]!
    );
    expect(
      vi.mocked(secureRuntime.reconcileProjectSelections!).mock
        .invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(secureRuntime.publish).mock.invocationCallOrder[0]!
    );
  });

  it("drains checkpoint batches while repeated poll failures back off", async () => {
    vi.useFakeTimers();
    const wakeClient = {
      query: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      release: vi.fn()
    };
    const entries = Array.from({ length: 21 }, (_, index) => ({
      id: `outbox-${index}`,
      groupId: "group",
      closureId: `closure-${index}`,
      packageId: `package-${index}`,
      sourceManifestHash: "hash",
      attemptCount: 1
    }));
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn(async () => entries.splice(0, 10)),
      beginPdsOutboxNetworkAction: vi.fn().mockResolvedValue(true),
      completePdsOutbox: vi.fn().mockResolvedValue(undefined),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn().mockRejectedValue(new Error("relay unavailable")),
      publish: vi
        .fn()
        .mockResolvedValue({ state: "committed", transportId: "transport" }),
      outboundState: vi.fn(),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;
    const service = createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool: { connect: vi.fn().mockResolvedValue(wakeClient) },
      logger: { warn: vi.fn() } as unknown as Logger,
      workerId: "worker"
    });

    try {
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(repository.completePdsOutbox).toHaveBeenCalledTimes(21);
      expect(secureRuntime.poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(secureRuntime.poll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(secureRuntime.poll).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(secureRuntime.poll).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(secureRuntime.poll).toHaveBeenCalledTimes(3);
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  });

  it("resumes polling when the retry deadline passes during checkpoint publication", async () => {
    vi.useFakeTimers();
    let releasePublish = () => {};
    const heldPublish = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const entries = Array.from({ length: 11 }, (_, index) => ({
      id: `outbox-${index}`,
      groupId: "group",
      closureId: `closure-${index}`,
      packageId: `package-${index}`,
      sourceManifestHash: "hash",
      attemptCount: 1
    }));
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn(async () => entries.splice(0, 10)),
      beginPdsOutboxNetworkAction: vi.fn().mockResolvedValue(true),
      completePdsOutbox: vi.fn().mockResolvedValue(undefined),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      poll: vi.fn().mockRejectedValue(new Error("relay unavailable")),
      publish: vi.fn(async ({ outboxId }: { outboxId: string }) => {
        if (outboxId === "outbox-10") await heldPublish;
        return { state: "committed" as const, transportId: "transport" };
      }),
      outboundState: vi.fn(),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;
    const service = createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool: {
        connect: vi.fn().mockResolvedValue({
          query: vi.fn().mockResolvedValue(undefined),
          on: vi.fn(),
          removeAllListeners: vi.fn(),
          release: vi.fn()
        })
      },
      logger: { warn: vi.fn() } as unknown as Logger,
      workerId: "worker"
    });

    try {
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(secureRuntime.publish).toHaveBeenCalledTimes(11);
      expect(repository.completePdsOutbox).toHaveBeenCalledTimes(10);
      await vi.advanceTimersByTimeAsync(1000);
      expect(secureRuntime.poll).toHaveBeenCalledTimes(1);
      releasePublish();
      await vi.advanceTimersByTimeAsync(0);
      expect(repository.completePdsOutbox).toHaveBeenCalledTimes(11);
      expect(secureRuntime.poll).toHaveBeenCalledTimes(2);
    } finally {
      releasePublish();
      await service.stop();
      vi.useRealTimers();
    }
  });

  it("ignores local wakes until the poll retry deadline", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (value: never) => void>();
    const wakeClient = {
      query: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, listener: (value: never) => void) =>
        listeners.set(event, listener)
      ),
      removeAllListeners: vi.fn(),
      release: vi.fn()
    };
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      poll: vi.fn().mockRejectedValue(new Error("relay unavailable")),
      publish: vi.fn(),
      outboundState: vi.fn(),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;
    const service = createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool: { connect: vi.fn().mockResolvedValue(wakeClient) },
      logger: { warn: vi.fn() } as unknown as Logger,
      workerId: "worker"
    });
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(500);
      expect(listeners.has("notification")).toBe(true);
      listeners.get("notification")!({
        channel: "koed_pds_local_sync"
      } as never);
      await vi.advanceTimersByTimeAsync(499);
      expect(secureRuntime.poll).toHaveBeenCalledTimes(1);
      expect(repository.claimPdsOutbox).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(secureRuntime.poll).toHaveBeenCalledTimes(2);
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  });

  it.each(["lifecycle", "repository"])(
    "keeps the original poll retry after a %s failure during checkpoint drain",
    async (failure) => {
      vi.useFakeTimers();
      let rejectDrain: (error: Error) => void = () => {};
      const heldDrain = new Promise<never>((_, reject) => {
        rejectDrain = reject;
      });
      const drainError = new Error(`${failure} unavailable`);
      const entries = Array.from({ length: 10 }, (_, index) => ({
        id: `outbox-${index}`,
        groupId: "group",
        closureId: `closure-${index}`,
        packageId: `package-${index}`,
        sourceManifestHash: "hash",
        attemptCount: 1
      }));
      const claim = vi.fn().mockResolvedValueOnce(entries);
      if (failure === "repository") claim.mockReturnValueOnce(heldDrain);
      claim.mockResolvedValue([]);
      const lifecycle = vi.fn().mockResolvedValueOnce(undefined);
      if (failure === "lifecycle") lifecycle.mockReturnValueOnce(heldDrain);
      lifecycle.mockResolvedValue(undefined);
      const repository = {
        heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
        claimPdsOutbox: claim,
        beginPdsOutboxNetworkAction: vi.fn().mockResolvedValue(true),
        completePdsOutbox: vi.fn().mockResolvedValue(undefined),
        getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
      } as unknown as MemorySourceRepository;
      const secureRuntime = {
        heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
        pollLifecycle: lifecycle,
        poll: vi.fn().mockRejectedValue(new Error("relay unavailable")),
        publish: vi
          .fn()
          .mockResolvedValue({ state: "committed", transportId: "transport" }),
        outboundState: vi.fn(),
        materialize: vi.fn()
      } as PdsWorkerSecureRuntime;
      const failureLogger = { warn: vi.fn() } as unknown as Logger;
      const service = createPdsLocalSyncService({
        repository,
        secureRuntime,
        wakePool: {
          connect: vi.fn().mockResolvedValue({
            query: vi.fn().mockResolvedValue(undefined),
            on: vi.fn(),
            removeAllListeners: vi.fn(),
            release: vi.fn()
          })
        },
        logger: failureLogger,
        workerId: "worker"
      });
      try {
        service.start();
        await vi.advanceTimersByTimeAsync(500);
        expect(secureRuntime.publish).toHaveBeenCalledTimes(10);
        rejectDrain(drainError);
        await vi.advanceTimersByTimeAsync(499);
        expect(failureLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: drainError }),
          expect.any(String)
        );
        expect(secureRuntime.poll).toHaveBeenCalledTimes(1);
        expect(secureRuntime.publish).toHaveBeenCalledTimes(10);
        await vi.advanceTimersByTimeAsync(1);
        expect(secureRuntime.poll).toHaveBeenCalledTimes(2);
      } finally {
        rejectDrain(drainError);
        await service.stop();
        vi.useRealTimers();
      }
    }
  );

  it("does not publish checkpoints when lifecycle authorization fails", async () => {
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn()
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi
        .fn()
        .mockRejectedValue(new Error("lifecycle unavailable")),
      poll: vi.fn(),
      publish: vi.fn(),
      outboundState: vi.fn(),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;

    await createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool,
      logger,
      workerId: "worker"
    }).run();

    expect(repository.claimPdsOutbox).not.toHaveBeenCalled();
    expect(secureRuntime.publish).not.toHaveBeenCalled();
  });

  it("stays idle before a device has joined a Personal Device Group", async () => {
    const repository = {
      heartbeatPdsWorker: vi.fn(),
      claimPdsOutbox: vi.fn()
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue([]),
      pollLifecycle: vi.fn().mockRejectedValue(new Error("must not run")),
      poll: vi.fn().mockRejectedValue(new Error("must not run")),
      publish: vi.fn(),
      outboundState: vi.fn(),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;

    await createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool,
      logger,
      workerId: "worker"
    }).run();

    expect(secureRuntime.heartbeatGroups).toHaveBeenCalledOnce();
    expect(secureRuntime.pollLifecycle).not.toHaveBeenCalled();
    expect(secureRuntime.poll).not.toHaveBeenCalled();
    expect(repository.heartbeatPdsWorker).not.toHaveBeenCalled();
    expect(repository.claimPdsOutbox).not.toHaveBeenCalled();
  });

  it("uses durable local and relay wakeups without periodic polling", async () => {
    const listeners = new Map<string, (value: never) => void>();
    const wakeClient = {
      query: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, listener: (value: never) => void) => {
        listeners.set(event, listener);
      }),
      removeAllListeners: vi.fn(),
      release: vi.fn()
    };
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    let relayWake: () => void = () => {
      throw new Error("Relay wake was not registered");
    };
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      refreshPeerRoutes: vi.fn().mockResolvedValue(undefined),
      pollLifecycle: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn().mockResolvedValue([]),
      waitForWake: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            relayWake = resolve;
          })
      ),
      publish: vi.fn(),
      outboundState: vi.fn(),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;
    const service = createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool: { connect: vi.fn().mockResolvedValue(wakeClient) },
      logger: { warn: vi.fn() } as unknown as Logger,
      workerId: "worker"
    });

    service.start();
    await vi.waitFor(() => {
      expect(secureRuntime.heartbeatGroups).toHaveBeenCalledTimes(1);
      expect(secureRuntime.refreshPeerRoutes).toHaveBeenCalledTimes(1);
      expect(secureRuntime.waitForWake).toHaveBeenCalledTimes(1);
    });

    listeners.get("notification")?.({
      channel: "koed_pds_local_sync"
    } as never);
    await vi.waitFor(() =>
      expect(secureRuntime.heartbeatGroups).toHaveBeenCalledTimes(2)
    );

    relayWake();
    await vi.waitFor(() =>
      expect(secureRuntime.heartbeatGroups).toHaveBeenCalledTimes(3)
    );
    expect(secureRuntime.refreshPeerRoutes).toHaveBeenCalledTimes(1);

    await service.stop();
    expect(wakeClient.query).toHaveBeenCalledWith(
      "unlisten koed_pds_local_sync"
    );
    expect(wakeClient.release).toHaveBeenCalledOnce();
  });

  it("does not rearm relay wake while the previous wake is being reconciled", async () => {
    let releaseReconciliation: () => void = () => undefined;
    const reconciliationHeld = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const heartbeatGroups = vi
      .fn()
      .mockResolvedValueOnce(["group"])
      .mockImplementationOnce(async () => {
        await reconciliationHeld;
        return ["group"];
      })
      .mockResolvedValue(["group"]);
    const secureRuntime = {
      heartbeatGroups,
      pollLifecycle: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn().mockResolvedValue([]),
      waitForWake: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn(),
      outboundState: vi.fn(),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;
    const service = createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool: {
        connect: vi.fn().mockResolvedValue({
          query: vi.fn().mockResolvedValue(undefined),
          on: vi.fn(),
          removeAllListeners: vi.fn(),
          release: vi.fn()
        })
      },
      logger: { warn: vi.fn() } as unknown as Logger,
      workerId: "worker"
    });

    try {
      service.start();
      await vi.waitFor(() => expect(heartbeatGroups).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(secureRuntime.waitForWake).toHaveBeenCalledTimes(1);
    } finally {
      releaseReconciliation();
      await service.stop();
    }
  });

  it("backs off after an unexpected reconciliation failure", async () => {
    vi.useFakeTimers();
    const wakeClient = {
      query: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      release: vi.fn()
    };
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi
        .fn()
        .mockRejectedValue(new Error("database unavailable")),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn().mockResolvedValue([]),
      publish: vi.fn(),
      outboundState: vi.fn(),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;
    const service = createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool: { connect: vi.fn().mockResolvedValue(wakeClient) },
      logger: { warn: vi.fn() } as unknown as Logger,
      workerId: "worker"
    });

    try {
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(repository.claimPdsOutbox).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(repository.claimPdsOutbox).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(repository.claimPdsOutbox).toHaveBeenCalledTimes(2);
    } finally {
      await service.stop();
      vi.useRealTimers();
    }
  });

  it("completes inbound materialization only after the relay ACK succeeds", async () => {
    const calls: string[] = [];
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      receivePdsInbox: vi.fn().mockResolvedValue("idempotent"),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([
        {
          id: "inbox",
          groupId: "group",
          packageId: "package",
          sourceManifestHash: "manifest",
          attemptCount: 1
        }
      ]),
      materializePdsReplica: vi.fn(async () => {
        calls.push("materialize");
        return { state: "ready", conflict: false };
      }),
      completePdsInbox: vi.fn(async () => {
        calls.push("complete");
        return true;
      }),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn().mockResolvedValue([]),
      publish: vi.fn(),
      outboundState: vi.fn(),
      materialize: vi.fn().mockResolvedValue({
        userId: "user",
        retainedPackageId: "retained",
        localSessionId: "session",
        sourceFingerprint: "fingerprint",
        closureHash: "closure",
        originDeploymentId: "deployment",
        originDeviceId: "origin-device",
        sourceSequence: "1",
        sourceClosedAt: new Date("2026-01-01T00:00:00.000Z"),
        observedAt: new Date("2026-01-01T00:00:01.000Z"),
        sourceItemIds: ["item"]
      }),
      acknowledge: vi.fn(async () => {
        calls.push("acknowledge");
      })
    } as PdsWorkerSecureRuntime;

    await createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool,
      logger,
      workerId: "worker"
    }).run();

    expect(calls).toEqual(["materialize", "acknowledge", "complete"]);
  });

  it("retains an inbound lease for retry when relay ACK fails", async () => {
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      receivePdsInbox: vi.fn().mockResolvedValue("idempotent"),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([
        {
          id: "inbox",
          groupId: "group",
          packageId: "package",
          sourceManifestHash: "manifest",
          attemptCount: 1
        }
      ]),
      materializePdsReplica: vi
        .fn()
        .mockResolvedValue({ state: "ready", conflict: false }),
      completePdsInbox: vi.fn(),
      markPdsInboxFailure: vi.fn().mockResolvedValue(true),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn().mockResolvedValue([]),
      publish: vi.fn(),
      outboundState: vi.fn(),
      materialize: vi.fn().mockResolvedValue({
        userId: "user",
        retainedPackageId: "retained",
        localSessionId: "session",
        sourceFingerprint: null,
        closureHash: "closure",
        originDeploymentId: "deployment",
        originDeviceId: "origin-device",
        sourceSequence: "1",
        sourceClosedAt: new Date("2026-01-01T00:00:00.000Z"),
        observedAt: new Date("2026-01-01T00:00:01.000Z"),
        sourceItemIds: ["item"]
      }),
      acknowledge: vi.fn().mockRejectedValue(new Error("relay unavailable"))
    } as PdsWorkerSecureRuntime;

    await createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool,
      logger,
      workerId: "worker"
    }).run();

    expect(repository.completePdsInbox).not.toHaveBeenCalled();
    expect(repository.markPdsInboxFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: "worker",
        inboxId: "inbox",
        permanent: false
      })
    );
  });

  it("promotes a committed outbox only after relay delivery is acknowledged", async () => {
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      receivePdsInbox: vi.fn().mockResolvedValue("idempotent"),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi.fn().mockResolvedValue([
        {
          id: "outbox",
          groupId: "group",
          transportId: "transport"
        }
      ]),
      completePdsOutbox: vi.fn().mockResolvedValue(true),
      releasePdsCommittedOutbox: vi.fn().mockResolvedValue(true),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn().mockResolvedValue([]),
      publish: vi.fn(),
      outboundState: vi.fn().mockResolvedValue("acked"),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;

    await createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool,
      logger,
      workerId: "worker"
    }).run();

    expect(repository.completePdsOutbox).toHaveBeenCalledWith({
      workerId: "worker",
      outboxId: "outbox",
      state: "acked",
      transportId: "transport"
    });
    expect(repository.releasePdsCommittedOutbox).not.toHaveBeenCalled();
  });

  it("requeues only a missing checkpoint transport for a fresh relay package", async () => {
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      receivePdsInbox: vi.fn().mockResolvedValue("idempotent"),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi
        .fn()
        .mockResolvedValue([
          { id: "outbox", groupId: "group", transportId: "expired-transport" }
        ]),
      completePdsOutbox: vi.fn().mockResolvedValue(true),
      requeuePdsExpiredCheckpointOutbox: vi.fn().mockResolvedValue(true),
      releasePdsCommittedOutbox: vi.fn().mockResolvedValue(true),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn().mockResolvedValue([]),
      publish: vi.fn(),
      outboundState: vi.fn().mockResolvedValue("missing"),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;

    await createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool,
      logger,
      workerId: "worker"
    }).run();

    expect(repository.requeuePdsExpiredCheckpointOutbox).toHaveBeenCalledWith({
      workerId: "worker",
      outboxId: "outbox",
      transportId: "expired-transport"
    });
    expect(repository.completePdsOutbox).not.toHaveBeenCalled();
    expect(repository.releasePdsCommittedOutbox).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "acknowledges an atomic checkpoint only after its predecessor is present (deferred=%s)",
    async (deferred) => {
      const repository = {
        heartbeatPdsWorker: vi.fn(),
        claimPdsOutbox: vi.fn().mockResolvedValue([]),
        claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
        claimPdsCommittedOutbox: vi.fn().mockResolvedValue([]),
        claimPdsInbox: vi.fn().mockResolvedValue([
          {
            id: "inbox",
            groupId: "group",
            packageId: "package",
            sourceManifestHash: "manifest",
            attemptCount: 1
          }
        ]),
        materializePdsReplica: vi.fn(),
        completePdsInbox: vi.fn().mockResolvedValue(true),
        getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
      };
      const secureRuntime = {
        heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
        poll: vi.fn().mockResolvedValue([]),
        acknowledge: vi.fn(),
        materialize: vi.fn().mockResolvedValue({
          kind: "checkpoint",
          userId: "user",
          retainedPackageId: "retained",
          originDeviceId: "studio",
          sourceSequence: "2",
          state: "ready",
          conflict: false,
          deferred
        })
      };
      await createPdsLocalSyncService({
        repository: repository as never,
        secureRuntime: secureRuntime as never,
        wakePool,
        logger,
        workerId: "worker"
      }).run();
      expect(repository.materializePdsReplica).not.toHaveBeenCalled();
      expect(secureRuntime.acknowledge).toHaveBeenCalledTimes(deferred ? 0 : 1);
      expect(repository.completePdsInbox).toHaveBeenCalledTimes(
        deferred ? 0 : 1
      );
    }
  );
});
