import { describe, expect, it } from "vitest";

import {
  aiClientCapabilityIds,
  aiClientModelLabel,
  assertAiClientDriverId,
  assertAiClientInstanceId,
  defaultAiClientInstanceId,
  isSupportedAiClientDriverId,
  sanitizeAiClientDiagnostics
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

describe("AI Client contract helpers", () => {
  it("keeps full model identity visible when display name is friendly", () => {
    expect(
      aiClientModelLabel({
        id: "model-1",
        displayName: "GPT 5",
        provider: "openai",
        model: "gpt-5",
        fullId: "openai/gpt-5"
      })
    ).toBe("GPT 5 (openai/gpt-5)");
  });

  it("includes fullId when display name matches provider/model", () => {
    expect(
      aiClientModelLabel({
        id: "model-1",
        displayName: "gpt-5",
        provider: "openai",
        model: "gpt-5",
        fullId: "openai/gpt-5"
      })
    ).toBe("gpt-5 (openai/gpt-5)");
  });

  it("falls back to provider/model and then model id", () => {
    expect(
      aiClientModelLabel({
        id: "model-1",
        provider: "openai",
        model: "gpt-5"
      })
    ).toBe("openai/gpt-5");
    expect(aiClientModelLabel({ id: "model-2" })).toBe("model-2");
  });

  it("redacts and bounds diagnostics", () => {
    const details = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `detail-${index}`,
        `token=secret-${index} ${"x".repeat(20)}`
      ])
    );
    const [diagnostic] = sanitizeAiClientDiagnostics([
      {
        code: "x".repeat(500),
        message: `Bearer super-secret ${"y".repeat(3000)}`,
        severity: "error",
        details
      }
    ]);

    expect(diagnostic).toEqual({
      code: "diagnostic",
      message: "AI Client diagnostic unavailable.",
      severity: "error"
    });
    expect(JSON.stringify(diagnostic)).not.toContain("super-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("detail-");
  });

  it("keeps only allowlisted generic diagnostics", () => {
    const diagnostics = sanitizeAiClientDiagnostics([
      {
        code: "discovery_failed",
        message: `spawn failed at /Users/test/.koed/client --token=secret`,
        severity: "error",
        details: { path: "/Users/test/.koed", token: "secret" }
      }
    ]);
    expect(diagnostics).toEqual([
      {
        code: "discovery_failed",
        message: "AI Client discovery failed.",
        severity: "error"
      }
    ]);
  });

  it("drops malformed diagnostics and caps diagnostic count", () => {
    expect(
      sanitizeAiClientDiagnostics([
        null,
        { code: "one", message: "one", severity: "info" },
        ...Array.from({ length: 120 }, () => ({
          code: "many",
          message: "many",
          severity: "warning"
        }))
      ])
    ).toHaveLength(100);
  });
});
