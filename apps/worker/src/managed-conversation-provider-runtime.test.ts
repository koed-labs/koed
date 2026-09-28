import { describe, expect, it, vi } from "vitest";

import {
  createManagedConversationLeaseHeartbeat,
  ManagedConversationRuntimeRegistry,
  runWithManagedConversationLease
} from "./managed-conversation-provider-runtime.js";

describe("ManagedConversationRuntimeRegistry", () => {
  it.each(["codex", "claude", "pi"] as const)(
    "does not reuse %s with changed turn settings",
    (provider) => {
      const registry = new ManagedConversationRuntimeRegistry();
      registry.set(provider, "execution", {
        executionGeneration: 1,
        aiClientInstanceId: `${provider}.default`,
        configIdentityHash: "installation",
        settingsKey: "old-settings",
        session: { closeAndWait: vi.fn() } as never
      });
      expect(
        registry.get(provider, "execution", { settingsKey: "old-settings" })
      ).toBeDefined();
      expect(
        registry.get(provider, "execution", { settingsKey: "new-settings" })
      ).toBeUndefined();
    }
  );
  it("keeps provider identity attached to a single execution registry", () => {
    const registry = new ManagedConversationRuntimeRegistry();
    const codexSession = {
      closeAndWait: vi.fn(async () => undefined)
    };

    registry.set("codex", "execution-1", {
      executionGeneration: 4,
      aiClientInstanceId: "codex.default",
      configIdentityHash: "config-hash",
      session: codexSession as never
    });

    expect(registry.get("codex", "execution-1")).toMatchObject({
      provider: "codex",
      executionGeneration: 4,
      session: codexSession
    });
    expect(registry.get("claude", "execution-1")).toBeUndefined();
  });
});

describe("runWithManagedConversationLease", () => {
  it("uses the same fencing path for every provider session", async () => {
    const session = { closeAndWait: vi.fn(async () => undefined) };
    let releaseOperation: (() => void) | undefined;
    const operationBlocked = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const result = runWithManagedConversationLease({
      session,
      heartbeatMs: 1,
      renew: async () => false,
      close: (owned) => owned.closeAndWait(),
      operation: async () => {
        await operationBlocked;
        return "finished";
      },
      leaseLostError: () => new Error("lease-lost")
    });

    await vi.waitFor(() => expect(session.closeAndWait).toHaveBeenCalledOnce());
    releaseOperation?.();

    await expect(result).rejects.toThrow("lease-lost");
  });

  it("returns provider work when command authority remains current", async () => {
    const session = { closeAndWait: vi.fn(async () => undefined) };

    await expect(
      runWithManagedConversationLease({
        session,
        heartbeatMs: 5,
        renew: async () => true,
        close: (owned) => owned.closeAndWait(),
        operation: async () => "finished",
        leaseLostError: () => new Error("lease-lost")
      })
    ).resolves.toBe("finished");
    expect(session.closeAndWait).not.toHaveBeenCalled();
  });
});

describe("managed conversation command lease heartbeat", () => {
  it("retries transient authority errors and continues after renewal succeeds", async () => {
    vi.useFakeTimers();
    const renew = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { statusCode: 429 }))
      .mockResolvedValue(true);
    const heartbeat = createManagedConversationLeaseHeartbeat({
      heartbeatMs: 45,
      retryMs: 5,
      leaseMs: 180,
      initialLeaseExpiresAt: Date.now() + 180,
      initialSafetyMarginMs: 20,
      renewalSafetyMarginMs: 20,
      renew,
      leaseLostError: () => new Error("lease-lost")
    });
    heartbeat.start();
    try {
      await vi.advanceTimersByTimeAsync(45);
      expect(renew).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5);
      expect(renew).toHaveBeenCalledTimes(2);
      // The successful renewal extends the safe deadline past the original
      // claim expiry, even while later renewals are still pending.
      await vi.advanceTimersByTimeAsync(120);
      expect(() => heartbeat.assertCurrent()).not.toThrow();
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });

  it("fences immediately when authority explicitly rejects the lease", async () => {
    vi.useFakeTimers();
    const session = { closeAndWait: vi.fn(async () => undefined) };
    const heartbeat = createManagedConversationLeaseHeartbeat({
      heartbeatMs: 10,
      leaseMs: 180,
      initialLeaseExpiresAt: Date.now() + 180,
      initialSafetyMarginMs: 10,
      renewalSafetyMarginMs: 10,
      renew: vi.fn(async () => false),
      leaseLostError: () => new Error("lease-lost")
    });
    heartbeat.watchSession(session);
    heartbeat.start();
    try {
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(session.closeAndWait).toHaveBeenCalledOnce());
      expect(() => heartbeat.assertCurrent()).toThrow("lease-lost");
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });

  it("fences by the confirmed deadline when all transient retries fail", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => {
      throw Object.assign(new Error("authority unavailable"), {
        statusCode: 503
      });
    });
    const heartbeat = createManagedConversationLeaseHeartbeat({
      heartbeatMs: 10,
      retryMs: 5,
      leaseMs: 100,
      initialLeaseExpiresAt: Date.now() + 100,
      initialSafetyMarginMs: 0,
      renewalSafetyMarginMs: 20,
      renew,
      leaseLostError: () => new Error("lease-lost")
    });
    heartbeat.start();
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(renew.mock.calls.length).toBeGreaterThan(1);
      expect(() => heartbeat.assertCurrent()).toThrow("lease-lost");
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });

  it("never overlaps a slow lease renewal", async () => {
    vi.useFakeTimers();
    let finishRenewal: ((renewed: boolean) => void) | undefined;
    const renew = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishRenewal = resolve;
        })
    );
    const heartbeat = createManagedConversationLeaseHeartbeat({
      heartbeatMs: 10,
      retryMs: 5,
      leaseMs: 10_000,
      initialLeaseExpiresAt: Date.now() + 10_000,
      initialSafetyMarginMs: 0,
      renewalSafetyMarginMs: 100,
      renew,
      leaseLostError: () => new Error("lease-lost")
    });
    heartbeat.start();
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(renew).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
      expect(renew).toHaveBeenCalledOnce();
      finishRenewal?.(true);
      await Promise.resolve();
      expect(() => heartbeat.assertCurrent()).not.toThrow();
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });

  it("closes the session at the safe deadline while a renewal is still pending", async () => {
    vi.useFakeTimers();
    const session = { closeAndWait: vi.fn(async () => undefined) };
    let finishRenewal: ((renewed: boolean) => void) | undefined;
    const renew = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishRenewal = resolve;
        })
    );
    const heartbeat = createManagedConversationLeaseHeartbeat({
      heartbeatMs: 10,
      retryMs: 5,
      leaseMs: 100,
      initialLeaseExpiresAt: Date.now() + 100,
      initialSafetyMarginMs: 0,
      renewalSafetyMarginMs: 20,
      renew,
      leaseLostError: () => new Error("lease-lost")
    });
    heartbeat.watchSession(session);
    heartbeat.start();
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(renew).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(70);
      await vi.waitFor(() => expect(session.closeAndWait).toHaveBeenCalledOnce());
      expect(() => heartbeat.assertCurrent()).toThrow("lease-lost");
      finishRenewal?.(true);
      await Promise.resolve();
      expect(() => heartbeat.assertCurrent()).toThrow("lease-lost");
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });

  it("shortens the first heartbeat delay when a claim has little lease time left", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => true);
    const heartbeat = createManagedConversationLeaseHeartbeat({
      heartbeatMs: 45,
      leaseMs: 100,
      initialLeaseExpiresAt: Date.now() + 40,
      initialSafetyMarginMs: 20,
      renewalSafetyMarginMs: 20,
      renew,
      leaseLostError: () => new Error("lease-lost")
    });
    heartbeat.start();
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(renew).toHaveBeenCalledOnce();
      expect(() => heartbeat.assertCurrent()).not.toThrow();
    } finally {
      heartbeat.stop();
      vi.useRealTimers();
    }
  });
});
