// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAiClientResponse } from "../../../ipc/local-ai-client-protocol.js";
import { LocalAiClientSettingsSection } from "./LocalAiClientSettingsSection.js";

const assignment = (
  provider: "codex" | "claude" | "pi",
  instance: string,
  model: string
) => ({
  provider,
  ai_client_instance_id: instance,
  model,
  reasoning_effort: "low",
  timeout_ms: 120_000,
  max_attempts: 2
});

const response = (): LocalAiClientResponse => ({
  operation: "list",
  readModel: {
    instances: [
      {
        instanceId: "codex.default",
        driverId: "codex",
        displayName: "Codex",
        enabled: true
      },
      {
        instanceId: "claude.work",
        driverId: "claude",
        displayName: "Claude Work",
        enabled: true
      },
      {
        instanceId: "pi.default",
        driverId: "pi",
        displayName: "Pi",
        enabled: true
      }
    ],
    capabilitySnapshots: [
      {
        instanceId: "codex.default",
        authenticationState: "authenticated",
        healthState: "healthy",
        models: [
          {
            displayName: "Luna",
            provider: "openai",
            model: "gpt-5.6-luna",
            fullId: "gpt-5.6-luna",
            reasoningEfforts: ["low", "high"]
          }
        ],
        localSynthesis: { support: "supported", readiness: "ready" },
        observedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        stale: false
      },
      {
        instanceId: "claude.work",
        authenticationState: "authenticated",
        healthState: "healthy",
        models: [
          {
            displayName: "Sonnet",
            provider: "anthropic",
            model: "sonnet",
            fullId: "claude/sonnet",
            reasoningEfforts: ["medium"]
          }
        ],
        localSynthesis: { support: "supported", readiness: "ready" },
        observedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        stale: false
      },
      {
        instanceId: "pi.default",
        authenticationState: "authenticated",
        healthState: "healthy",
        models: [
          {
            displayName: "GPT 5",
            provider: "openai",
            model: "gpt-5",
            fullId: "openai/gpt-5",
            reasoningEfforts: ["high"]
          }
        ],
        localSynthesis: { support: "supported", readiness: "ready" },
        observedAt: "2025-01-01T00:00:00.000Z",
        expiresAt: "2025-01-02T00:00:00.000Z",
        stale: true
      }
    ],
    settings: [
      {
        flowKey: "mcp_memory_answer",
        provider: "pi",
        aiClientInstanceId: "pi.default",
        model: "openai/gpt-5",
        reasoningEffort: "high",
        timeoutMs: 120_000,
        maxAttempts: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    defaults: {
      mcp_memory_answer: {
        source: "code",
        available: true,
        assignment: assignment("codex", "codex.default", "gpt-5.6-luna"),
        reason: null
      },
      lcm_summary: {
        source: "code",
        available: true,
        assignment: assignment("codex", "codex.default", "gpt-5.6-luna"),
        reason: null
      },
      session_title: {
        source: "code",
        available: true,
        assignment: assignment("codex", "codex.default", "gpt-5.6-luna"),
        reason: null
      },
      curated_memory_review: {
        source: "code",
        available: true,
        assignment: assignment("codex", "codex.default", "gpt-5.6-luna"),
        reason: null
      }
    }
  }
});

describe("Local AI Client settings selectors", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
  });

  it("shows exactly supported flows, provider/model metadata, reasoning, and stale assignment diagnostics", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const api = {
      list: vi.fn(async () => response()),
      refresh: vi.fn(async () => ({
        ...response(),
        operation: "refresh" as const,
        refreshed: true,
        refreshError: null
      })),
      set: vi.fn(async () => response()),
      reset: vi.fn(async () => response())
    };
    root = createRoot(container);
    await act(async () =>
      root!.render(<LocalAiClientSettingsSection localAiClients={api} />)
    );
    await vi.waitFor(() =>
      expect(container.querySelectorAll("fieldset")).toHaveLength(4)
    );

    expect(container.textContent).toContain("Memory Answer");
    expect(container.textContent).toContain("Claude Work");
    expect(container.textContent).toContain("openai/gpt-5");
    expect(container.textContent).toContain("GPT 5 (openai/gpt-5)");
    expect(container.textContent).toContain("stale capability snapshot");
    expect(container.textContent).not.toContain("Manual Memory Answer");
    expect(container.querySelectorAll("select").length).toBeGreaterThan(0);
    expect(
      container.querySelector(
        'select[aria-label="Memory Answer reasoning effort"]'
      )
    ).toBeTruthy();
  });

  it("filters by provider and keeps native selectors keyboard-accessible", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const api = {
      list: vi.fn(async () => response()),
      refresh: vi.fn(async () => ({
        ...response(),
        operation: "refresh" as const,
        refreshed: true,
        refreshError: null
      })),
      set: vi.fn(async () => response()),
      reset: vi.fn(async () => response())
    };
    root = createRoot(container);
    await act(async () =>
      root!.render(<LocalAiClientSettingsSection localAiClients={api} />)
    );
    await vi.waitFor(() =>
      expect(container.querySelector('input[type="search"]')).toBeTruthy()
    );
    const search = container.querySelector<HTMLInputElement>(
      'input[type="search"]'
    )!;
    await act(async () => {
      search.value = "anthropic";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await vi.waitFor(() => {
      const instanceSelect = container.querySelector<HTMLSelectElement>(
        'select[aria-label="LCM Summary AI Client instance"]'
      );
      expect(instanceSelect?.textContent).toContain("Claude Work");
    });
    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="LCM Summary model"]'
    );
    expect(modelSelect?.getAttribute("aria-describedby")).toBe(
      "lcm_summary-status"
    );
    expect(modelSelect?.tagName).toBe("SELECT");
  });

  it("keeps newer refresh results over older save responses and guards same-flow saves", async () => {
    container = document.createElement("div");
    document.body.append(container);
    let resolveSave: ((value: LocalAiClientResponse) => void) | undefined;
    let refreshCalls = 0;
    const saveResponse = new Promise<LocalAiClientResponse>((resolve) => {
      resolveSave = resolve;
    });
    const newer = response();
    newer.operation = "refresh";
    newer.readModel.instances[0]!.displayName = "Newer refresh";
    const api = {
      list: vi.fn(async () => response()),
      refresh: vi.fn(async () => {
        refreshCalls += 1;
        return refreshCalls === 1 ? response() : newer;
      }),
      set: vi.fn(() => saveResponse),
      reset: vi.fn(async () => response())
    };
    root = createRoot(container);
    await act(async () =>
      root!.render(<LocalAiClientSettingsSection localAiClients={api} />)
    );
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    const reasoning = container.querySelector<HTMLSelectElement>(
      'select[aria-label="LCM Summary reasoning effort"]'
    )!;
    await act(async () => {
      reasoning.value = "high";
      reasoning.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save LCM Summary")
    )!;
    await act(async () => {
      save.click();
      save.click();
    });
    expect(api.set).toHaveBeenCalledTimes(1);
    const refresh = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Refresh capabilities")
    )!;
    await act(async () => {
      refresh.click();
      await vi.waitFor(() => expect(refreshCalls).toBe(2));
      resolveSave!(response());
      await saveResponse;
    });
    expect(container.textContent).toContain("Newer refresh");
  });

  it("keeps reset independent and leaves persisted read model visible on refresh timeout", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const api = {
      list: vi.fn(async () => response()),
      refresh: vi.fn(async () => {
        throw new Error("Capability refresh timed out");
      }),
      set: vi.fn(async () => response()),
      reset: vi.fn(async () => response())
    };
    root = createRoot(container);
    await act(async () =>
      root!.render(<LocalAiClientSettingsSection localAiClients={api} />)
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Memory Answer")
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Capability refresh timed out")
    );
    const reset = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Reset assignment"
    );
    expect(reset).toBeTruthy();
    await act(async () => reset!.click());
    expect(api.reset).toHaveBeenCalledWith("mcp_memory_answer");
    expect(container.textContent).toContain("LCM Summary");
  });
});
