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
            id: "gpt-5.6-luna",
            displayName: "Luna",
            provider: "openai",
            model: "gpt-5.6-luna",
            fullId: "openai/gpt-5.6-luna",
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
            id: "sonnet",
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
            id: "openai/gpt-5",
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

const flowFieldset = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("fieldset")].find(
    (fieldset) => fieldset.querySelector("legend")?.textContent === label
  );

describe("Agent Configuration selectors", () => {
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

    expect(container.textContent).toContain("Agent Configuration");
    expect(container.textContent).not.toContain(
      "Choose which local AI Client handles each flow"
    );
    expect(container.textContent).toContain(
      "Sets the agent, model, and reasoning effort for answers from recalled evidence."
    );
    expect(container.textContent).toContain(
      "Sets the agent, model, and reasoning effort for summaries of stored memory."
    );
    expect(container.textContent).toContain(
      "Sets the agent, model, and reasoning effort for titles of captured sessions."
    );
    expect(container.textContent).toContain(
      "Sets the agent, model, and reasoning effort for reviews of Curated Memory proposals."
    );
    expect(container.textContent).not.toContain("Documented default (code)");
    expect(container.textContent).toContain("Memory Answer");
    expect(container.textContent).toContain("Claude Work");
    expect(container.textContent).toContain("openai/gpt-5");
    expect(container.textContent).toContain("GPT 5 (openai/gpt-5)");
    expect(container.textContent).toContain("stale capability snapshot");
    expect(
      container
        .querySelector("#lcm_summary-status")
        ?.classList.contains("koed-visually-hidden")
    ).toBe(true);
    expect(container.querySelector("#lcm_summary-status")?.textContent).toBe(
      "Ready"
    );
    const agentSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="LCM Summary Agent"]'
    )!;
    expect(
      [...agentSelect.options].map((option) => option.textContent)
    ).toEqual(["Codex", "Claude Work", "Pi — Stale capability snapshot"]);
    expect(agentSelect.textContent).not.toContain("codex.default");
    const reasoningSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="LCM Summary reasoning effort"]'
    )!;
    expect(
      [...reasoningSelect.options].map((option) => option.textContent)
    ).toEqual(["Low", "High"]);
    expect([...reasoningSelect.options].map((option) => option.value)).toEqual([
      "low",
      "high"
    ]);
    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="LCM Summary model"]'
      )?.value
    ).toBe("codex.default\u0000gpt-5.6-luna");
    expect(container.textContent).not.toContain("Manual Memory Answer");
    expect(container.querySelectorAll("select").length).toBeGreaterThan(0);
    expect(
      container.querySelector(
        'select[aria-label="Memory Answer reasoning effort"]'
      )
    ).toBeTruthy();
    const lcmFieldset = flowFieldset(container, "LCM Summary")!;
    expect(
      [...lcmFieldset.querySelectorAll("button")].map(
        (button) => button.textContent
      )
    ).toEqual(["Save", "Reset"]);
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh capabilities"]'
    )!;
    expect(refresh.textContent).toBe("");
    expect(refresh.querySelector(".lucide-refresh-cw")).toBeTruthy();
  });

  it("hides search while keeping native selectors keyboard-accessible", async () => {
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
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(container.textContent).not.toContain(
      "Search client, provider, display name, model, or full model ID"
    );
    const instanceSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="LCM Summary Agent"]'
    );
    expect(instanceSelect?.textContent).toContain("Claude Work");
    const modelSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="LCM Summary model"]'
    );
    expect(modelSelect?.getAttribute("aria-describedby")).toBe(
      "lcm_summary-status"
    );
    expect(modelSelect?.tagName).toBe("SELECT");
  });

  it("keeps qualified legacy assignments selected through their native executable ID", async () => {
    container = document.createElement("div");
    document.body.append(container);
    const legacy = response();
    legacy.readModel.settings.push({
      flowKey: "lcm_summary",
      provider: "codex",
      aiClientInstanceId: "codex.default",
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "low",
      timeoutMs: 120_000,
      maxAttempts: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const api = {
      list: vi.fn(async () => legacy),
      refresh: vi.fn(async () => legacy),
      set: vi.fn(async () => legacy),
      reset: vi.fn(async () => legacy)
    };
    root = createRoot(container);
    await act(async () =>
      root!.render(<LocalAiClientSettingsSection localAiClients={api} />)
    );
    await vi.waitFor(() =>
      expect(
        container.querySelector<HTMLSelectElement>(
          'select[aria-label="LCM Summary model"]'
        )?.value
      ).toBe("codex.default\u0000gpt-5.6-luna")
    );
    expect(
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="LCM Summary model"]'
      )?.value
    ).toBe("codex.default\u0000gpt-5.6-luna");
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
    const lcmFieldset = flowFieldset(container, "LCM Summary")!;
    const save = [...lcmFieldset.querySelectorAll("button")].find(
      (button) => button.textContent === "Save"
    )!;
    await act(async () => {
      save.click();
      save.click();
    });
    expect(api.set).toHaveBeenCalledTimes(1);
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh capabilities"]'
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
    const memoryAnswerFieldset = flowFieldset(container, "Memory Answer")!;
    const reset = [...memoryAnswerFieldset.querySelectorAll("button")].find(
      (button) => button.textContent === "Reset"
    );
    expect(reset).toBeTruthy();
    await act(async () => reset!.click());
    expect(api.reset).toHaveBeenCalledWith("mcp_memory_answer");
    expect(container.textContent).toContain("LCM Summary");
  });
});
