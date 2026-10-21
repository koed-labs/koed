import { describe, expect, it, vi } from "vitest";

import {
  ManagedConversationRuntimeRegistry,
  managedConversationPolicySettingsKey,
  matchesManagedConversationPolicySettingsKey,
  quiesceManagedConversationRuntimeSession,
  runWithManagedConversationLease
} from "./managed-conversation-provider-runtime.js";

describe("ManagedConversationRuntimeRegistry", () => {
  it("reuses the original normal settings key and switches only a catch-up turn", () => {
    const base = "current-settings";
    expect(managedConversationPolicySettingsKey(base, false)).toBe(base);
    expect(managedConversationPolicySettingsKey(base, true)).toBe(
      `${base}:catch_up_read_only`
    );
    expect(matchesManagedConversationPolicySettingsKey(base, base)).toBe(true);
    expect(
      matchesManagedConversationPolicySettingsKey(
        `${base}:catch_up_read_only`,
        base
      )
    ).toBe(true);
    expect(
      matchesManagedConversationPolicySettingsKey(`${base}:normal`, base)
    ).toBe(false);
    expect(
      matchesManagedConversationPolicySettingsKey(
        `${base}:catch_up_read_only`,
        "changed-settings"
      )
    ).toBe(false);
  });
  it("never replaces a possibly live session through set or clear", async () => {
    const registry = new ManagedConversationRuntimeRegistry();
    const first = {
      closeAndWait: vi.fn().mockRejectedValueOnce(new Error("still live"))
    };
    const second = { closeAndWait: vi.fn() };
    registry.set("codex", "execution", {
      executionGeneration: 1,
      aiClientInstanceId: "codex.default",
      configIdentityHash: "config",
      session: first as never
    });
    expect(() =>
      registry.set("codex", "execution", {
        executionGeneration: 2,
        aiClientInstanceId: "codex.default",
        configIdentityHash: "config",
        session: second as never
      })
    ).toThrow("ManagedConversationRuntimeStillActiveError");
    await expect(registry.clear()).rejects.toThrow("still live");
    expect(registry.get("codex", "execution")?.session).toBe(first);
    await expect(registry.clear(false)).rejects.toThrow(
      "ManagedConversationRuntimeStillActiveError"
    );
    first.closeAndWait.mockResolvedValueOnce(undefined);
    await registry.clear();
    expect(registry.has("execution")).toBe(false);
    expect(second.closeAndWait).not.toHaveBeenCalled();
  });
  it.each(["codex", "pi"] as const)(
    "refuses a %s policy switch until the previous process closes",
    async (provider) => {
      const registry = new ManagedConversationRuntimeRegistry();
      const closeAndWait = vi
        .fn()
        .mockRejectedValueOnce(new Error("still live"));
      registry.set(provider, "execution", {
        executionGeneration: 1,
        aiClientInstanceId: `${provider}.default`,
        configIdentityHash: "installation",
        settingsKey: "normal",
        session: { closeAndWait } as never
      });
      await expect(
        quiesceManagedConversationRuntimeSession(
          registry,
          provider,
          "execution"
        )
      ).rejects.toThrow("still live");
      expect(registry.get(provider, "execution")?.settingsKey).toBe("normal");
      expect(registry.get(provider, "execution")?.session.closeAndWait).toBe(
        closeAndWait
      );
      closeAndWait.mockResolvedValueOnce(undefined);
      await quiesceManagedConversationRuntimeSession(
        registry,
        provider,
        "execution"
      );
      expect(registry.get(provider, "execution")).toBeUndefined();
    }
  );
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
  it("waits for a failed provider close before reporting lease loss", async () => {
    let rejectClose: ((error: Error) => void) | undefined;
    let releaseOperation: (() => void) | undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectClose = reject;
        })
    );
    const operation = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const result = runWithManagedConversationLease({
      session: {},
      heartbeatMs: 1,
      renew: async () => false,
      close,
      operation: async () => {
        await operation;
        return "finished";
      },
      leaseLostError: () => new Error("lease-lost")
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    releaseOperation?.();
    let settled = false;
    void result
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);
    rejectClose?.(new Error("close-unconfirmed"));
    await expect(result).rejects.toThrow("close-unconfirmed");
  });
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
