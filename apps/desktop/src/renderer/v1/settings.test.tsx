// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopStatusStore,
  StatusSnapshot
} from "../services/desktop-commands.js";
import type { ThemeStore, ThemeSnapshot } from "../state/theme.js";
import { DEFAULT_AGENT_LOOK } from "./visual.js";
import { V1Settings } from "./settings.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
describe("V1Settings", () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshot: StatusSnapshot;
  let theme: ThemeSnapshot;
  let statusStore: DesktopStatusStore;
  let themeStore: ThemeStore;
  let run: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    snapshot = { status: null, busyCommand: null, error: null, revision: 0 };
    theme = {
      preference: "system",
      resolved: "dark",
      loading: false,
      error: null
    };
    run = vi.fn(async () => ({ ok: true }));
    statusStore = {
      current: () => snapshot,
      subscribe: () => () => undefined,
      refresh: vi.fn(async () => null),
      run
    } as unknown as DesktopStatusStore;
    themeStore = {
      current: () => theme,
      subscribe: () => () => undefined,
      set: vi.fn(async (preference: "system" | "light" | "dark") => ({
        ...theme,
        preference
      }))
    } as unknown as ThemeStore;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = async (
    initialTab: "general" | "agent" | "ai" | "services" = "general",
    onSaveAgent = vi.fn(),
    overrides: Partial<ComponentProps<typeof V1Settings>> = {}
  ) => {
    await act(async () =>
      root.render(
        <V1Settings
          initialTab={initialTab}
          agent={{ name: "Koed", look: DEFAULT_AGENT_LOOK }}
          onSaveAgent={onSaveAgent}
          statusStore={statusStore}
          themeStore={themeStore}
          onClose={vi.fn()}
          {...overrides}
        />
      )
    );
    return onSaveAgent;
  };
  it("writes theme through the existing ThemeStore", async () => {
    await render();
    await act(async () =>
      (
        container.querySelector(
          ".v1-settings-segment button:nth-child(2)"
        ) as HTMLButtonElement
      ).click()
    );
    expect(themeStore.set).toHaveBeenCalledWith("light");
  });

  it("uses supported launch and graphics bridges, and restarts onboarding by callback", async () => {
    const launch = {
      get: vi.fn(async () => ({
        enabled: false,
        status: "disabled" as const,
        supported: true
      })),
      set: vi.fn(async (enabled: boolean) => ({
        enabled,
        status: enabled ? ("enabled" as const) : ("disabled" as const),
        supported: true
      }))
    };
    const graphics = {
      get: vi.fn(async () => ({ enabled: true, managedByEnvironment: false })),
      set: vi.fn(async (enabled: boolean) => ({
        enabled,
        managedByEnvironment: false
      }))
    };
    const restart = vi.fn(async () => undefined);
    await render("general", vi.fn(), {
      launchAtStartup: launch,
      hardwareAcceleration: graphics,
      onRestartOnboarding: restart
    });
    const login = container.querySelector(
      'button[aria-label="Open Koed at login"]'
    ) as HTMLButtonElement;
    const gpu = container.querySelector(
      'button[aria-label="Graphics acceleration"]'
    ) as HTMLButtonElement;
    expect(login.getAttribute("aria-checked")).toBe("false");
    expect(gpu.getAttribute("aria-checked")).toBe("true");
    await act(async () => login.click());
    expect(launch.set).toHaveBeenCalledWith(true);
    await act(async () => gpu.click());
    expect(graphics.set).toHaveBeenCalledWith(false);
    await act(async () =>
      (
        container.querySelector(
          ".v1-settings-group button.v1-settings-secondary"
        ) as HTMLButtonElement
      ).click()
    );
    expect(restart).toHaveBeenCalledOnce();
  });
  it("keeps operator managed graphics disabled", async () => {
    const graphics = {
      get: vi.fn(async () => ({ enabled: true, managedByEnvironment: true })),
      set: vi.fn()
    };
    await render("general", vi.fn(), { hardwareAcceleration: graphics });
    const gpu = container.querySelector(
      'button[aria-label="Graphics acceleration"]'
    ) as HTMLButtonElement;
    expect(gpu.disabled).toBe(true);
    expect(graphics.set).not.toHaveBeenCalled();
  });
  it("saves a capability backed default for new conversations", async () => {
    const assignment = {
      provider: "codex" as const,
      ai_client_instance_id: "codex-local",
      model: "model-a",
      reasoning_effort: "medium",
      timeout_ms: 120000,
      max_attempts: 2
    };
    const readModel = {
      instances: [
        {
          instanceId: "codex-local",
          driverId: "codex",
          displayName: "Codex",
          enabled: true
        }
      ],
      capabilitySnapshots: [
        {
          instanceId: "codex-local",
          authenticationState: "authenticated",
          healthState: "healthy",
          stale: false,
          expiresAt: "2099-01-01T00:00:00Z",
          managedConversationStart: {
            support: "supported",
            readiness: "ready"
          },
          models: [
            {
              id: "model-a",
              fullId: "model-a",
              model: "model-a",
              displayName: "Model A",
              reasoningEfforts: ["medium", "high"]
            }
          ]
        }
      ],
      settings: [],
      defaults: {
        conversations: { available: true, persistable: true, assignment }
      }
    } as never;
    const localAiClients = {
      list: vi.fn(async () => ({ operation: "list" as const, readModel })),
      refresh: vi.fn(async () => ({
        operation: "refresh" as const,
        readModel
      })),
      set: vi.fn(async () => ({ operation: "set" as const, readModel })),
      reset: vi.fn()
    };
    await render("ai", vi.fn(), { localAiClients });
    const reasoning = container.querySelector(
      'select[aria-label="Default conversation reasoning"]'
    ) as HTMLSelectElement;
    await act(async () => {
      reasoning.value = "high";
      reasoning.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      (
        container.querySelector(
          ".v1-conversation-defaults .v1-settings-primary"
        ) as HTMLButtonElement
      ).click()
    );
    expect(localAiClients.set).toHaveBeenCalledWith("conversations", {
      ...assignment,
      reasoning_effort: "high"
    });
  });
  it("saves a selected agent name and look through the callback", async () => {
    const save = await render("agent");
    await act(async () => {
      const input = container.querySelector(
        'input[type="text"]'
      ) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "Pip");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      (
        container.querySelector(
          'button[aria-label="mint"]'
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      (
        container.querySelector(".v1-settings-primary") as HTMLButtonElement
      ).click()
    );
    expect(save).toHaveBeenCalledWith({
      name: "Pip",
      look: { ...DEFAULT_AGENT_LOOK, color: "mint" }
    });
  });
  it("requires explicit consent before changing an AI Client profile", async () => {
    snapshot = {
      ...snapshot,
      status: {
        generatedAt: "2026-01-01T00:00:00Z",
        codex: { configured: false, state: "not_configured" },
        aiClients: {
          codex: { installed: { state: "healthy" }, authentication: "unknown" }
        }
      } as never
    };
    await render("ai");
    await act(async () => {
      const connect = [
        ...container.querySelectorAll(".v1-client-card:first-child button")
      ].find((b) => b.textContent?.includes("Connect")) as HTMLButtonElement;
      connect.click();
    });
    expect(run).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    await act(async () =>
      (
        container.querySelector(
          ".v1-settings-confirm .v1-settings-primary"
        ) as HTMLButtonElement
      ).click()
    );
    expect(run).toHaveBeenCalledWith("setup_codex", {
      operatorConsented: true
    });
  });
  it("shows real service states without a fake running state", async () => {
    snapshot = {
      ...snapshot,
      status: {
        generatedAt: "2026-01-01T00:00:00Z",
        api: { state: "healthy", message: "API ready" },
        database: { state: "needs_attention", message: "Database unavailable" }
      } as never
    };
    await render("services");
    expect(container.textContent).toContain("API ready");
    expect(container.textContent).toContain("Database unavailable");
    expect(container.textContent).toContain("Needs attention");
  });
});
