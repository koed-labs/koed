import { describe, expect, it, vi } from "vitest";

import {
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
