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

  it.each(["source", "artifact"] as const)(
    "reconciles other %s entries when one ACK lookup hangs, and ignores its late result",
    async (kind) => {
      vi.useFakeTimers();
      let resolveSlow!: (state: "acked") => void;
      const slow = new Promise<"acked">((resolve) => {
        resolveSlow = resolve;
      });
      const entries = ["slow", "fast"].map((id) => ({
        id,
        groupId: "group",
        transportId: id,
        artifactId: id
      }));
      const completed: string[] = [];
      const released: string[] = [];
      const repository = {
        heartbeatPdsWorker: vi.fn(),
        claimPdsOutbox: vi.fn().mockResolvedValue([]),
        claimPdsCommittedOutbox: vi
          .fn()
          .mockResolvedValue(kind === "source" ? entries : []),
        claimPdsArtifactOutbox: vi
          .fn()
          .mockImplementation(({ state }) =>
            Promise.resolve(
              state === "committed" && kind === "artifact" ? entries : []
            )
          ),
        claimPdsInbox: vi.fn().mockResolvedValue([]),
        completePdsOutbox: vi.fn(async ({ outboxId }) => {
          completed.push(outboxId);
          return true;
        }),
        completePdsArtifactOutbox: vi.fn(async ({ outboxId }) => {
          completed.push(outboxId);
          return true;
        }),
        releasePdsCommittedOutbox: vi.fn(async ({ outboxId }) => {
          released.push(outboxId);
          return true;
        }),
        releasePdsCommittedArtifactOutbox: vi.fn(async ({ outboxId }) => {
          released.push(outboxId);
          return true;
        })
      } as unknown as MemorySourceRepository;
      let slowSignal: AbortSignal | undefined;
      const secureRuntime = {
        heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
        poll: vi.fn().mockResolvedValue([]),
        outboundState: vi.fn(({ transportId, signal }) => {
          if (transportId === "slow") {
            slowSignal = signal;
            return slow;
          }
          return Promise.resolve("acked");
        })
      } as unknown as PdsWorkerSecureRuntime;
      try {
        const service = createPdsLocalSyncService({
          repository,
          secureRuntime,
          wakePool,
          logger
        });
        const run = service.run();
        await vi.advanceTimersByTimeAsync(0);
        expect(completed).toEqual(["fast"]);
        await vi.advanceTimersByTimeAsync(31_000);
        await run;
        expect(slowSignal?.aborted).toBe(true);
        expect(released).toEqual(["slow"]);
        const retry = service.run();
        await vi.advanceTimersByTimeAsync(31_000);
        await retry;
        expect(
          vi
            .mocked(secureRuntime.outboundState)
            .mock.calls.filter(([entry]) => entry.transportId === "slow")
        ).toHaveLength(1);
        expect(released).toEqual(["slow"]);
        resolveSlow("acked");
        await Promise.resolve();
        expect(completed).toEqual(["fast", "fast"]);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each([
    ["source", false],
    ["artifact", false],
    ["source", true],
    ["artifact", true]
  ] as const)(
    "bounds overlapping %s claims with started service: %s",
    async (kind, started) => {
      let releaseClaim!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      let claimed = 0;
      let active = 0;
      let peak = 0;
      const claim = async ({ limit = 10 }: { limit?: number }) => {
        await claimGate;
        const count = Math.min(limit, 10);
        return Array.from({ length: count }, () => {
          const id = `${kind}-${claimed++}`;
          return { id, artifactId: id, groupId: "group", transportId: id };
        });
      };
      const repository = {
        heartbeatPdsWorker: vi.fn(),
        claimPdsOutbox: vi.fn().mockResolvedValue([]),
        claimPdsCommittedOutbox: vi.fn((args) =>
          kind === "source" ? claim(args) : Promise.resolve([])
        ),
        claimPdsArtifactOutbox: vi.fn((args) =>
          kind === "artifact" && args.state === "committed"
            ? claim(args)
            : Promise.resolve([])
        ),
        claimPdsInbox: vi.fn().mockResolvedValue([]),
        releasePdsCommittedOutbox: vi.fn(),
        releasePdsCommittedArtifactOutbox: vi.fn(),
        getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
      } as unknown as MemorySourceRepository;
      const secureRuntime = {
        heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
        poll: vi.fn().mockResolvedValue([]),
        outboundState: vi.fn(() => {
          active++;
          peak = Math.max(peak, active);
          return new Promise(() => {});
        })
      } as unknown as PdsWorkerSecureRuntime;
      const service = createPdsLocalSyncService({
        repository,
        secureRuntime,
        logger,
        wakePool: {
          connect: vi.fn().mockResolvedValue({
            query: vi.fn().mockResolvedValue(undefined),
            on: vi.fn(),
            removeAllListeners: vi.fn(),
            release: vi.fn()
          })
        }
      });
      try {
        const first = service.run();
        const target =
          kind === "source"
            ? repository.claimPdsCommittedOutbox
            : repository.claimPdsArtifactOutbox;
        await vi.waitFor(() => expect(target).toHaveBeenCalled());
        if (started) service.start();
        const second = service.run();
        await new Promise((resolve) => setTimeout(resolve, 20));
        releaseClaim();
        await vi.waitFor(() => expect(active).toBeGreaterThanOrEqual(10));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(peak).toBe(10);
        await service.stop();
        await Promise.all([first, second]);
      } finally {
        releaseClaim();
        await service.stop();
      }
    }
  );

  it("recovers after more than 20 cooperative ACK timeouts", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const repository = {
      heartbeatPdsWorker: vi.fn(),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi
        .fn()
        .mockResolvedValue([
          { id: "source", groupId: "group", transportId: "transport" }
        ]),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      completePdsOutbox: vi.fn(),
      releasePdsCommittedOutbox: vi.fn().mockResolvedValue(true)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      poll: vi.fn().mockResolvedValue([]),
      outboundState: vi.fn(({ signal }) => {
        attempts++;
        if (attempts > 25) return Promise.resolve("acked");
        return new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("aborted")));
        });
      })
    } as unknown as PdsWorkerSecureRuntime;
    try {
      const service = createPdsLocalSyncService({
        repository,
        secureRuntime,
        wakePool,
        logger
      });
      for (let i = 0; i < 25; i++) {
        const run = service.run();
        await vi.advanceTimersByTimeAsync(30_001);
        await run;
      }
      await service.run();
      expect(attempts).toBe(26);
      expect(repository.releasePdsCommittedOutbox).toHaveBeenCalledTimes(25);
      expect(repository.completePdsOutbox).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["source", "acked"],
    ["source", "committed"],
    ["artifact", "acked"],
    ["artifact", "committed"]
  ] as const)(
    "bounds %s ACKs through hung %s finalization while the other class progresses",
    async (kind, state) => {
      let finish!: () => void;
      const stalled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const entries = Array.from({ length: 10 }, (_, index) => ({
        id: `${kind}-${index}`,
        artifactId: `${kind}-${index}`,
        groupId: "group",
        transportId: `${kind}-${index}`
      }));
      const other = {
        id: "other",
        artifactId: "other",
        groupId: "group",
        transportId: "other"
      };
      const finalize = vi.fn(({ outboxId }) =>
        outboxId === "other" ? Promise.resolve() : stalled
      );
      const repository = {
        heartbeatPdsWorker: vi.fn(),
        claimPdsOutbox: vi.fn().mockResolvedValue([]),
        claimPdsCommittedOutbox: vi
          .fn()
          .mockResolvedValue(kind === "source" ? entries : [other]),
        claimPdsArtifactOutbox: vi.fn(({ state: claimState }) =>
          Promise.resolve(
            claimState === "committed"
              ? kind === "artifact"
                ? entries
                : [other]
              : []
          )
        ),
        claimPdsInbox: vi.fn().mockResolvedValue([]),
        completePdsOutbox: finalize,
        completePdsArtifactOutbox: finalize,
        releasePdsCommittedOutbox: finalize,
        releasePdsCommittedArtifactOutbox: finalize
      } as unknown as MemorySourceRepository;
      const secureRuntime = {
        heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
        poll: vi.fn().mockResolvedValue([]),
        outboundState: vi.fn(({ transportId }) =>
          Promise.resolve(transportId === "other" ? "acked" : state)
        )
      } as unknown as PdsWorkerSecureRuntime;
      const service = createPdsLocalSyncService({
        repository,
        secureRuntime,
        wakePool,
        logger
      });
      const first = service.run();
      try {
        await vi.waitFor(() => expect(finalize).toHaveBeenCalledTimes(11));
        const second = service.run();
        await vi.waitFor(() =>
          expect(
            finalize.mock.calls.filter(([entry]) => entry.outboxId === "other")
          ).toHaveLength(2)
        );
        expect(
          finalize.mock.calls.filter(([entry]) => entry.outboxId !== "other")
        ).toHaveLength(10);
        finish();
        await Promise.all([first, second]);
      } finally {
        finish();
        await service.stop();
      }
    }
  );

  it.each(["deadline", "stop"] as const)(
    "returns from run on %s even when ACK database finalization hangs",
    async (ending) => {
      vi.useFakeTimers();
      let finish!: () => void;
      const stalled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const repository = {
        heartbeatPdsWorker: vi.fn(),
        claimPdsOutbox: vi.fn().mockResolvedValue([]),
        claimPdsCommittedOutbox: vi
          .fn()
          .mockResolvedValue([
            { id: "source", groupId: "group", transportId: "source" }
          ]),
        claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
        claimPdsInbox: vi.fn().mockResolvedValue([]),
        completePdsOutbox: vi.fn(() => stalled)
      } as unknown as MemorySourceRepository;
      const secureRuntime = {
        heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
        poll: vi.fn().mockResolvedValue([]),
        outboundState: vi.fn().mockResolvedValue("acked")
      } as unknown as PdsWorkerSecureRuntime;
      const service = createPdsLocalSyncService({
        repository,
        secureRuntime,
        wakePool,
        logger
      });
      let returned = false;
      const run = service.run().then(() => {
        returned = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(repository.completePdsOutbox).toHaveBeenCalledOnce();
        if (ending === "stop") await service.stop();
        else await vi.advanceTimersByTimeAsync(30_001);
        await vi.advanceTimersByTimeAsync(0);
        expect(returned).toBe(true);
      } finally {
        finish();
        await run;
        await service.stop();
        vi.useRealTimers();
      }
    }
  );

  it.each(["source", "artifact"] as const)(
    "excludes a hung %s finalization from later claims while refilling other slots",
    async (kind) => {
      let finish!: () => void;
      const stalled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const entry = (id: string) => ({
        id,
        artifactId: id,
        groupId: "group",
        transportId: id
      });
      const claim = vi.fn(({ excludeIds = [] }) =>
        Promise.resolve(
          excludeIds.includes("stalled") ? [entry("next")] : [entry("stalled")]
        )
      );
      const complete = vi.fn(({ outboxId }) =>
        outboxId === "stalled" ? stalled : Promise.resolve()
      );
      const repository = {
        heartbeatPdsWorker: vi.fn(),
        claimPdsOutbox: vi.fn().mockResolvedValue([]),
        claimPdsCommittedOutbox:
          kind === "source" ? claim : vi.fn().mockResolvedValue([]),
        claimPdsArtifactOutbox: vi.fn((args) =>
          args.state === "committed" && kind === "artifact"
            ? claim(args)
            : Promise.resolve([])
        ),
        claimPdsInbox: vi.fn().mockResolvedValue([]),
        completePdsOutbox: complete,
        completePdsArtifactOutbox: complete
      } as unknown as MemorySourceRepository;
      const secureRuntime = {
        heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
        poll: vi.fn().mockResolvedValue([]),
        outboundState: vi.fn().mockResolvedValue("acked")
      } as unknown as PdsWorkerSecureRuntime;
      const service = createPdsLocalSyncService({
        repository,
        secureRuntime,
        wakePool,
        logger
      });
      const first = service.run();
      try {
        await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
        await service.run();
        expect(claim).toHaveBeenLastCalledWith(
          expect.objectContaining({ excludeIds: ["stalled"], limit: 9 })
        );
        expect(complete).toHaveBeenCalledWith(
          expect.objectContaining({ outboxId: "next" })
        );
      } finally {
        finish();
        await first;
        await service.stop();
      }
    }
  );

  it("allows artifact ACKs when abort-ignoring source lookups saturate", async () => {
    vi.useFakeTimers();
    const sources = Array.from({ length: 10 }, (_, index) => ({
      id: `source-${index}`,
      groupId: "group",
      transportId: `source-${index}`
    }));
    const repository = {
      heartbeatPdsWorker: vi.fn(),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi.fn().mockResolvedValue(sources),
      claimPdsArtifactOutbox: vi.fn(({ state }) =>
        Promise.resolve(
          state === "committed"
            ? [
                {
                  id: "artifact",
                  artifactId: "artifact",
                  groupId: "group",
                  transportId: "artifact"
                }
              ]
            : []
        )
      ),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      completePdsArtifactOutbox: vi.fn(),
      releasePdsCommittedOutbox: vi.fn().mockResolvedValue(true)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      poll: vi.fn().mockResolvedValue([]),
      outboundState: vi.fn(({ transportId }) =>
        transportId === "artifact"
          ? Promise.resolve("acked")
          : new Promise(() => {})
      )
    } as unknown as PdsWorkerSecureRuntime;
    try {
      const service = createPdsLocalSyncService({
        repository,
        secureRuntime,
        wakePool,
        logger
      });
      const first = service.run();
      await vi.advanceTimersByTimeAsync(30_001);
      await first;
      await service.run();
      expect(repository.claimPdsCommittedOutbox).toHaveBeenCalledOnce();
      expect(repository.completePdsArtifactOutbox).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("processes artifact ACK and inbox while a source ACK is stalled", async () => {
    vi.useFakeTimers();
    const repository = {
      heartbeatPdsWorker: vi.fn(),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi
        .fn()
        .mockResolvedValue([
          { id: "source", groupId: "group", transportId: "source" }
        ]),
      claimPdsArtifactOutbox: vi.fn(({ state }) =>
        Promise.resolve(
          state === "committed"
            ? [
                {
                  id: "artifact",
                  artifactId: "artifact",
                  groupId: "group",
                  transportId: "artifact"
                }
              ]
            : []
        )
      ),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      completePdsArtifactOutbox: vi.fn(),
      releasePdsCommittedOutbox: vi.fn()
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      poll: vi.fn().mockResolvedValue([]),
      outboundState: vi.fn(({ transportId }) =>
        transportId === "source"
          ? new Promise(() => {})
          : Promise.resolve("acked")
      )
    } as unknown as PdsWorkerSecureRuntime;
    try {
      const service = createPdsLocalSyncService({
        repository,
        secureRuntime,
        wakePool,
        logger
      });
      const run = service.run();
      await vi.advanceTimersByTimeAsync(0);
      expect(repository.completePdsArtifactOutbox).toHaveBeenCalledOnce();
      expect(repository.claimPdsInbox).toHaveBeenCalledOnce();
      await service.stop();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });

  it("refills available source ACK slots while another source lookup is stalled", async () => {
    const source = (id: string) => ({ id, groupId: "group", transportId: id });
    const repository = {
      heartbeatPdsWorker: vi.fn(),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi
        .fn()
        .mockResolvedValueOnce([source("slow"), source("fast")])
        .mockResolvedValueOnce([source("next")])
        .mockResolvedValue([]),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      completePdsOutbox: vi.fn(),
      releasePdsCommittedOutbox: vi.fn(),
      getPdsLocalSyncWakeAt: vi.fn().mockResolvedValue(null)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      poll: vi.fn().mockResolvedValue([]),
      outboundState: vi.fn(({ transportId }) =>
        transportId === "slow"
          ? new Promise(() => {})
          : Promise.resolve("acked")
      )
    } as unknown as PdsWorkerSecureRuntime;
    const service = createPdsLocalSyncService({
      repository,
      secureRuntime,
      logger,
      wakePool: {
        connect: vi.fn().mockResolvedValue({
          query: vi.fn().mockResolvedValue(undefined),
          on: vi.fn(),
          removeAllListeners: vi.fn(),
          release: vi.fn()
        })
      }
    });
    try {
      service.start();
      await vi.waitFor(() =>
        expect(repository.completePdsOutbox).toHaveBeenCalledWith(
          expect.objectContaining({ outboxId: "next", state: "acked" })
        )
      );
      expect(secureRuntime.outboundState).toHaveBeenCalledTimes(3);
    } finally {
      await service.stop();
    }
  });

  it("does not start lifecycle after stop during heartbeat", async () => {
    let resolveHeartbeat!: (groups: string[]) => void;
    const heartbeat = new Promise<string[]>((resolve) => {
      resolveHeartbeat = resolve;
    });
    const repository = {
      heartbeatPdsWorker: vi.fn()
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn(() => heartbeat),
      pollLifecycle: vi.fn()
    } as unknown as PdsWorkerSecureRuntime;
    const service = createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool,
      logger
    });
    const run = service.run();
    await service.stop();
    resolveHeartbeat(["group"]);
    await run;
    expect(repository.heartbeatPdsWorker).not.toHaveBeenCalled();
    expect(secureRuntime.pollLifecycle).not.toHaveBeenCalled();
  });

  it("does not start artifact or inbox phases when stopped during source claim", async () => {
    let finishClaim!: (entries: []) => void;
    const claim = new Promise<[]>((resolve) => {
      finishClaim = resolve;
    });
    const repository = {
      heartbeatPdsWorker: vi.fn(),
      claimPdsOutbox: vi.fn(() => claim),
      claimPdsArtifactOutbox: vi.fn(),
      claimPdsCommittedOutbox: vi.fn(),
      claimPdsInbox: vi.fn()
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      poll: vi.fn().mockResolvedValue([])
    } as unknown as PdsWorkerSecureRuntime;
    const service = createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool,
      logger
    });
    const run = service.run();
    await vi.waitFor(() =>
      expect(repository.claimPdsOutbox).toHaveBeenCalledOnce()
    );
    await service.stop();
    finishClaim([]);
    await run;
    expect(repository.claimPdsArtifactOutbox).not.toHaveBeenCalled();
    expect(repository.claimPdsCommittedOutbox).not.toHaveBeenCalled();
    expect(repository.claimPdsInbox).not.toHaveBeenCalled();
  });

  it("aborts an active ACK lookup on stop and ignores a late result", async () => {
    let resolveLookup!: (state: "acked") => void;
    let signal: AbortSignal | undefined;
    const lookup = new Promise<"acked">((resolve) => {
      resolveLookup = resolve;
    });
    const repository = {
      heartbeatPdsWorker: vi.fn(),
      claimPdsOutbox: vi.fn().mockResolvedValue([]),
      claimPdsCommittedOutbox: vi
        .fn()
        .mockResolvedValue([
          { id: "source", groupId: "group", transportId: "transport" }
        ]),
      claimPdsArtifactOutbox: vi.fn().mockResolvedValue([]),
      claimPdsInbox: vi.fn().mockResolvedValue([]),
      completePdsOutbox: vi.fn(),
      releasePdsCommittedOutbox: vi.fn().mockResolvedValue(true)
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
      poll: vi.fn().mockResolvedValue([]),
      outboundState: vi.fn((input) => {
        signal = input.signal;
        return lookup;
      })
    } as unknown as PdsWorkerSecureRuntime;
    const service = createPdsLocalSyncService({
      repository,
      secureRuntime,
      wakePool,
      logger
    });
    const run = service.run();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await service.stop();
    await run;
    expect(signal?.aborted).toBe(true);
    resolveLookup("acked");
    await Promise.resolve();
    expect(repository.completePdsOutbox).not.toHaveBeenCalled();
    expect(repository.releasePdsCommittedOutbox).toHaveBeenCalledOnce();
  });

  it.each(["source", "artifact"] as const)(
    "wakes unrelated due work while %s ACKs are saturated without spinning",
    async (kind) => {
      vi.useFakeTimers();
      const entries = Array.from({ length: 10 }, (_, i) => ({
        id: `${kind}-${i}`,
        artifactId: `${kind}-${i}`,
        groupId: "group",
        transportId: `${kind}-${i}`
      }));
      let inboxClaims = 0;
      const due = new Date(Date.now() + 1000).toISOString();
      const repository = {
        heartbeatPdsWorker: vi.fn(),
        claimPdsOutbox: vi.fn().mockResolvedValue([]),
        claimPdsCommittedOutbox: vi
          .fn()
          .mockResolvedValue(kind === "source" ? entries : []),
        claimPdsArtifactOutbox: vi.fn(({ state }) =>
          Promise.resolve(
            state === "committed" && kind === "artifact" ? entries : []
          )
        ),
        claimPdsInbox: vi.fn(async () => {
          inboxClaims++;
          return [];
        }),
        releasePdsCommittedOutbox: vi.fn(),
        releasePdsCommittedArtifactOutbox: vi.fn(),
        getPdsLocalSyncWakeAt: vi.fn(async () => (inboxClaims < 3 ? due : null))
      } as unknown as MemorySourceRepository;
      const secureRuntime = {
        heartbeatGroups: vi.fn().mockResolvedValue(["group"]),
        poll: vi.fn().mockResolvedValue([]),
        outboundState: vi.fn(() => new Promise(() => {}))
      } as unknown as PdsWorkerSecureRuntime;
      const service = createPdsLocalSyncService({
        repository,
        secureRuntime,
        logger,
        wakePool: {
          connect: vi.fn().mockResolvedValue({
            query: vi.fn().mockResolvedValue(undefined),
            on: vi.fn(),
            removeAllListeners: vi.fn(),
            release: vi.fn()
          })
        }
      });
      try {
        service.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(inboxClaims).toBe(2); // Full first claim requests one immediate drain.
        expect(repository.getPdsLocalSyncWakeAt).toHaveBeenLastCalledWith(
          expect.objectContaining({
            excludeSourceAcknowledgements: kind === "source",
            excludeArtifactAcknowledgements: kind === "artifact"
          })
        );
        await vi.advanceTimersByTimeAsync(1000);
        expect(inboxClaims).toBe(3);
        await vi.advanceTimersByTimeAsync(29_000);
        const afterTimeout = inboxClaims;
        await vi.advanceTimersByTimeAsync(5000);
        expect(inboxClaims).toBe(afterTimeout);
        expect(secureRuntime.outboundState).toHaveBeenCalledTimes(10);
      } finally {
        await service.stop();
        vi.useRealTimers();
      }
    }
  );

  it("does not spin on overdue work without an available group", async () => {
    const repository = {
      getPdsLocalSyncWakeAt: vi
        .fn()
        .mockResolvedValue(new Date(0).toISOString())
    } as unknown as MemorySourceRepository;
    const secureRuntime = {
      heartbeatGroups: vi.fn().mockResolvedValue([])
    } as unknown as PdsWorkerSecureRuntime;
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
      logger,
      workerId: "worker"
    });
    try {
      service.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(secureRuntime.heartbeatGroups).toHaveBeenCalledOnce();
    } finally {
      await service.stop();
    }
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
      workerId: vi.mocked(repository.claimPdsCommittedOutbox).mock.calls[0]![0]
        .workerId,
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
      workerId: vi.mocked(repository.claimPdsCommittedOutbox).mock.calls[0]![0]
        .workerId,
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
