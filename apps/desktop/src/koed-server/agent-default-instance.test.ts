import { describe, expect, it } from "vitest";
import type { AgentBootstrapContext } from "@koed/shared/agent-contract";
import { resolveChiefDefaultInstance } from "./agent-default-instance.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const context = (): AgentBootstrapContext => ({
  ownerUserId,
  savedConversations: null,
  enabledInstances: [
    { instanceId: "codex.default", driverId: "codex" },
    { instanceId: "claude.work", driverId: "claude" }
  ]
});

describe("Chief default AI Client instance", () => {
  it("uses the documented code default when no setting overrides it", () => {
    expect(resolveChiefDefaultInstance(context(), ownerUserId, {})).toBe(
      "codex.default"
    );
  });
  it("uses an environment default only for a matching registered instance", () => {
    expect(
      resolveChiefDefaultInstance(context(), ownerUserId, {
        KOED_CONVERSATIONS_PROVIDER: "claude",
        KOED_CONVERSATIONS_AI_CLIENT_INSTANCE: "claude.work"
      })
    ).toBe("claude.work");
  });
  it("lets the authenticated owner's saved conversations setting override environment", () => {
    const value = context();
    value.savedConversations = {
      provider: "claude",
      aiClientInstanceId: "claude.work"
    };
    expect(resolveChiefDefaultInstance(value, ownerUserId, {})).toBe(
      "claude.work"
    );
  });
  it("rejects a cached other-owner setting even when its instance ID overlaps", () => {
    const stale = context();
    stale.ownerUserId = "22222222-2222-4222-8222-222222222222";
    stale.savedConversations = {
      provider: "codex",
      aiClientInstanceId: "codex.default"
    };
    expect(() => resolveChiefDefaultInstance(stale, ownerUserId, {})).toThrow(
      "owner identity mismatch"
    );
  });
  it("does not guess an instance for missing, disabled, mismatched or invalid defaults", () => {
    const missing = context();
    missing.enabledInstances = [];
    expect(resolveChiefDefaultInstance(missing, ownerUserId, {})).toBeNull();
    const wrongDriver = context();
    wrongDriver.enabledInstances[0]!.driverId = "claude";
    expect(
      resolveChiefDefaultInstance(wrongDriver, ownerUserId, {})
    ).toBeNull();
    const invalidSaved = context();
    invalidSaved.savedConversations = {
      provider: "codex",
      aiClientInstanceId: "codex.missing"
    };
    expect(
      resolveChiefDefaultInstance(invalidSaved, ownerUserId, {})
    ).toBeNull();
    expect(
      resolveChiefDefaultInstance(context(), ownerUserId, {
        KOED_CONVERSATIONS_PROVIDER: "unknown"
      })
    ).toBeNull();
  });
});
