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

  it("defers relay data-plane work while the Authority epoch is pending", async () => {
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn(),
      claimPdsArtifactOutbox: vi.fn(),
      claimPdsCommittedOutbox: vi.fn(),
      claimPdsInbox: vi.fn()
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi.fn().mockResolvedValue(false),
      refreshPeerRoutes: vi.fn(),
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

    expect(secureRuntime.pollLifecycle).toHaveBeenCalledOnce();
    expect(secureRuntime.refreshPeerRoutes).not.toHaveBeenCalled();
    expect(repository.claimPdsOutbox).not.toHaveBeenCalled();
    expect(repository.claimPdsArtifactOutbox).not.toHaveBeenCalled();
    expect(repository.claimPdsCommittedOutbox).not.toHaveBeenCalled();
    expect(secureRuntime.poll).not.toHaveBeenCalled();
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

  it("cancels a remote long poll before reconciling local work", async () => {
    let notify: ((message: { channel: string }) => void) | undefined;
    let wakeSignal: AbortSignal | undefined;
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi.fn(async () => {
        if (wakeSignal && !wakeSignal.aborted)
          throw new Error("lifecycle blocked by long poll");
      }),
      poll: vi.fn().mockResolvedValue([]),
      waitForWake: vi.fn((signal: AbortSignal) => {
        wakeSignal = signal;
        return new Promise<void>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            {
              once: true
            }
          );
        });
      }),
      publish: vi.fn(),
      outboundState: vi.fn(),
      materialize: vi.fn()
    } as PdsWorkerSecureRuntime;
    const warnings = vi.fn();
    const service = createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool: {
        connect: vi.fn().mockResolvedValue({
          query: vi.fn().mockResolvedValue(undefined),
          on: vi.fn((event, listener) => {
            if (event === "notification") notify = listener;
          }),
          removeAllListeners: vi.fn(),
          release: vi.fn()
        })
      },
      logger: { warn: warnings } as unknown as Logger
    });
    try {
      service.start();
      await vi.waitFor(() =>
        expect(secureRuntime.waitForWake).toHaveBeenCalledOnce()
      );
      const previousWake = wakeSignal!;
      notify?.({ channel: "koed_pds_local_sync" });
      await vi.waitFor(() =>
        expect(repository.claimPdsOutbox).toHaveBeenCalledTimes(2)
      );
      expect(previousWake.aborted).toBe(true);
      expect(warnings).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(secureRuntime.waitForWake).toHaveBeenCalledTimes(2)
      );
    } finally {
      await service.stop();
    }
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

  it("publishes due checkpoints before potentially slow artifact reconciliation", async () => {
    const calls: string[] = [];
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn(async () => {
        calls.push("claim");
        return [
          {
            id: "checkpoint-outbox",
            groupId: "group",
            closureId: "checkpoint-closure",
            packageId: "checkpoint-package",
            sourceManifestHash: "checkpoint-manifest",
            attemptCount: 1
          }
        ];
      }),
      beginPdsOutboxNetworkAction: vi.fn().mockResolvedValue(true),
      completePdsOutbox: vi.fn().mockResolvedValue(true),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([])
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi.fn().mockResolvedValue(true),
      reconcileArtifacts: vi.fn(async () => {
        calls.push("reconcile-artifacts");
        throw new Error("artifact work is temporarily unavailable");
      }),
      poll: vi.fn().mockResolvedValue([]),
      publish: vi.fn(async () => {
        calls.push("publish");
        return { state: "committed" as const, transportId: "transport" };
      }),
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

    expect(calls).toEqual(
      expect.arrayContaining(["claim", "publish", "reconcile-artifacts"])
    );
    expect(calls.indexOf("claim")).toBeLessThan(
      calls.indexOf("reconcile-artifacts")
    );
    expect(calls.indexOf("publish")).toBeLessThan(
      calls.indexOf("reconcile-artifacts")
    );
  });

  it("claims and publishes a pending checkpoint even when inbound relay polling fails", async () => {
    const repository = {
      heartbeatPdsWorker: vi.fn().mockResolvedValue(undefined),
      claimPdsOutbox: vi.fn().mockResolvedValue([
        {
          id: "checkpoint-outbox",
          groupId: "group",
          closureId: "checkpoint-closure",
          packageId: "checkpoint-package",
          sourceManifestHash: "checkpoint-manifest",
          attemptCount: 1
        }
      ]),
      beginPdsOutboxNetworkAction: vi.fn().mockResolvedValue(true),
      completePdsOutbox: vi.fn().mockResolvedValue(true),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      pollLifecycle: vi.fn().mockResolvedValue(undefined),
      poll: vi.fn().mockRejectedValue(new Error("inbound relay unavailable")),
      publish: vi.fn().mockResolvedValue({
        state: "committed",
        transportId: "checkpoint-transport"
      }),
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

    expect(repository.claimPdsOutbox).toHaveBeenCalledOnce();
    expect(repository.beginPdsOutboxNetworkAction).toHaveBeenCalledWith({
      workerId: "worker",
      outboxId: "checkpoint-outbox"
    });
    expect(secureRuntime.publish).toHaveBeenCalledWith({
      workerId: "worker",
      outboxId: "checkpoint-outbox",
      closureId: "checkpoint-closure",
      packageId: "checkpoint-package",
      sourceManifestHash: "checkpoint-manifest"
    });
    expect(repository.completePdsOutbox).toHaveBeenCalledWith({
      workerId: "worker",
      outboxId: "checkpoint-outbox",
      state: "committed",
      transportId: "checkpoint-transport"
    });
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
