import { describe, expect, it } from "vitest";

import {
  aiClientCapabilityIds,
  assertAiClientDriverId,
  assertAiClientInstanceId,
  defaultAiClientInstanceId,
  isSupportedAiClientDriverId
} from "./ai-client-contract.js";

describe("AI Client identifiers", () => {
  it("accepts open identifiers while recognizing built-in drivers", () => {
    expect(assertAiClientDriverId("future-client.v2")).toBe("future-client.v2");
    expect(assertAiClientInstanceId("future-client.work-account")).toBe(
      "future-client.work-account"
    );
    expect(isSupportedAiClientDriverId("future-client")).toBe(false);
    expect(isSupportedAiClientDriverId("claude")).toBe(true);
    expect(defaultAiClientInstanceId("claude")).toBe("claude.default");
  });

  it("keeps client capability and model identities separate", () => {
    expect(aiClientCapabilityIds.localSynthesis).toBe("local_synthesis");
    expect(new Set(Object.values(aiClientCapabilityIds)).size).toBe(
      Object.values(aiClientCapabilityIds).length
    );
    const target = {
      driverId: "claude" as const,
      instanceId: "claude.work" as const,
      model: {
        provider: "anthropic",
        model: "claude-sonnet-4",
        fullId: "anthropic/claude-sonnet-4"
      },
      reasoningEffort: "high"
    };
    expect(target).toMatchObject({
      driverId: "claude",
      instanceId: "claude.work",
      model: { provider: "anthropic", model: "claude-sonnet-4" }
    });
    expect(target.model).not.toHaveProperty("driverId");
  });

  it.each(["", "../claude", "Claude", "claude/default", "claude default"])(
    "rejects unsafe identifier %s",
    (value) => {
      expect(() => assertAiClientDriverId(value)).toThrow();
      expect(() => assertAiClientInstanceId(value)).toThrow();
    }
  );
});
