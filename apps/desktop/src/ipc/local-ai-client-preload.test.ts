import { describe, expect, it, vi } from "vitest";
import { createLocalAiClientPreloadApi } from "./local-ai-client-preload.js";
import {
  localAiClientCommandChannel,
  localAiClientUsageChangedChannel
} from "./local-ai-client-protocol.js";

const readModel = {
  instances: [],
  capabilitySnapshots: [],
  settings: [],
  defaults: {
    conversations: {
      source: "code",
      available: true,
      assignment: {
        provider: "codex",
        ai_client_instance_id: "codex.default",
        model: "gpt-5.6-luna",
        reasoning_effort: "low",
        timeout_ms: 120000,
        max_attempts: 2
      },
      reason: null
    },
    mcp_memory_answer: {
      source: "code",
      available: true,
      assignment: {
        provider: "codex",
        ai_client_instance_id: "codex.default",
        model: "gpt-5.6-luna",
        reasoning_effort: "low",
        timeout_ms: 120000,
        max_attempts: 2
      },
      reason: null
    },
    lcm_summary: {
      source: "code",
      available: true,
      assignment: {
        provider: "codex",
        ai_client_instance_id: "codex.default",
        model: "gpt-5.6-luna",
        reasoning_effort: "low",
        timeout_ms: 120000,
        max_attempts: 2
      },
      reason: null
    },
    session_title: {
      source: "code",
      available: true,
      assignment: {
        provider: "codex",
        ai_client_instance_id: "codex.default",
        model: "gpt-5.6-luna",
        reasoning_effort: "low",
        timeout_ms: 120000,
        max_attempts: 2
      },
      reason: null
    },
    curated_memory_review: {
      source: "code",
      available: true,
      assignment: {
        provider: "codex",
        ai_client_instance_id: "codex.default",
        model: "gpt-5.6-luna",
        reasoning_effort: "low",
        timeout_ms: 90000,
        max_attempts: 2
      },
      reason: null
    }
  }
};

describe("Local AI Client preload bridge", () => {
  it("uses strict list, set, and reset commands without exposing authority", async () => {
    const invoke = vi.fn().mockResolvedValue({ operation: "list", readModel });
    const api = createLocalAiClientPreloadApi(invoke);
    await api.list();
    expect(invoke).toHaveBeenCalledWith(localAiClientCommandChannel, {
      operation: "list"
    });
    expect(Object.keys(api).sort()).toEqual([
      "list",
      "onUsageChanged",
      "refresh",
      "reset",
      "set",
      "usage"
    ]);
    expect(Object.isFrozen(api)).toBe(true);
  });

  it("rejects injected unknown or sensitive DTO fields", async () => {
    const injected = structuredClone(readModel) as Record<string, unknown>;
    (injected.instances as unknown[]).push({
      instanceId: "secret",
      driverId: "codex",
      displayName: "bad",
      enabled: true,
      token: "must-not-cross"
    });
    const api = createLocalAiClientPreloadApi(
      vi.fn().mockResolvedValue({ operation: "list", readModel: injected })
    );
    await expect(api.list()).rejects.toThrow();
  });

  it("rejects a response for a different operation", async () => {
    const api = createLocalAiClientPreloadApi(
      vi.fn().mockResolvedValue({ operation: "reset", readModel })
    );
    await expect(api.list()).rejects.toThrow(
      "Invalid Local AI Client operation correlation."
    );
  });

  it("validates flow and assignment before IPC", async () => {
    const invoke = vi.fn().mockResolvedValue({ operation: "reset", readModel });
    const api = createLocalAiClientPreloadApi(invoke);
    await api.reset("mcp_memory_answer");
    expect(invoke).toHaveBeenCalledWith(localAiClientCommandChannel, {
      operation: "reset",
      flowKey: "mcp_memory_answer"
    });
    await expect(api.reset("manual_memory_answer" as never)).rejects.toThrow();
  });

  it("unsubscribes usage listeners and discards invalid event fields", () => {
    let eventListener: ((_event: unknown, value: unknown) => void) | undefined;
    const events = {
      on: vi.fn(
        (
          _channel: string,
          listener: (_event: unknown, value: unknown) => void
        ) => {
          eventListener = listener;
        }
      ),
      removeListener: vi.fn()
    };
    const api = createLocalAiClientPreloadApi(vi.fn(), events);
    const listener = vi.fn();
    const unsubscribe = api.onUsageChanged(listener);
    const valid = {
      kind: "completion",
      instanceId: "codex.default",
      completionId: "one",
      outcome: "checked",
      observedAt: "2026-10-23T12:00:00.000Z"
    };
    eventListener?.({}, { ...valid, accountIdentityHash: "secret" });
    expect(listener).not.toHaveBeenCalled();
    eventListener?.({}, valid);
    expect(listener).toHaveBeenCalledWith(valid);
    eventListener?.({}, { kind: "invalidated" });
    expect(listener).toHaveBeenCalledWith({ kind: "invalidated" });
    unsubscribe();
    expect(events.removeListener).toHaveBeenCalledWith(
      localAiClientUsageChangedChannel,
      eventListener
    );
  });
});
