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
    vi.useRealTimers();
    container.remove();
    delete window.koedDesktop;
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

  it("uses presentation preferences for window graphics and menu bar", async () => {
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
    let preferences = { graphicsAcceleration: true, showMenuBar: false };
    const presentation = {
      get: vi.fn(async () => preferences),
      set: vi.fn(async (value: typeof preferences) => {
        preferences = value;
        return preferences;
      })
    };
    const restart = vi.fn(async () => undefined);
    await render("general", vi.fn(), {
      launchAtStartup: launch,
      presentationPreferences: presentation,
      onRestartOnboarding: restart
    });
    const deviceSection = [...container.querySelectorAll("section")].find(
      (section) => section.querySelector("h4")?.textContent === "On this device"
    )!;
    for (const label of [
      "Open Koed at login",
      "Graphics acceleration",
      "Show Koed in the menu bar"
    ]) {
      const controls = container.querySelectorAll(
        `button[aria-label="${label}"]`
      );
      expect(controls).toHaveLength(1);
      expect(deviceSection.contains(controls[0]!)).toBe(true);
    }
    const setupButtons = [
      ...container.querySelectorAll<HTMLButtonElement>("button")
    ].filter((button) => button.textContent === "Run setup again");
    expect(setupButtons).toHaveLength(1);
    expect(deviceSection.contains(setupButtons[0]!)).toBe(true);
    expect(launch.get).toHaveBeenCalledOnce();
    expect(presentation.get).toHaveBeenCalledOnce();
    const login = container.querySelector(
      'button[aria-label="Open Koed at login"]'
    ) as HTMLButtonElement;
    const gpu = container.querySelector(
      'button[aria-label="Graphics acceleration"]'
    ) as HTMLButtonElement;
    const menu = container.querySelector(
      'button[aria-label="Show Koed in the menu bar"]'
    ) as HTMLButtonElement;
    expect(gpu.getAttribute("aria-checked")).toBe("true");
    expect(menu.getAttribute("aria-checked")).toBe("false");
    await act(async () => login.click());
    expect(launch.set).toHaveBeenCalledWith(true);
    await act(async () => gpu.click());
    expect(presentation.set).toHaveBeenCalledWith({
      graphicsAcceleration: false,
      showMenuBar: false
    });
    await act(async () => menu.click());
    expect(presentation.set).toHaveBeenCalledWith({
      graphicsAcceleration: false,
      showMenuBar: true
    });
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Run setup again")!
        .click()
    );
    expect(restart).toHaveBeenCalledOnce();
  });
  it("keeps the displayed window preference when saving fails", async () => {
    const presentation = {
      get: vi.fn(async () => ({
        graphicsAcceleration: true,
        showMenuBar: true
      })),
      set: vi.fn(async () => {
        throw new Error("unavailable");
      })
    };
    await render("general", vi.fn(), { presentationPreferences: presentation });
    const gpu = container.querySelector(
      'button[aria-label="Graphics acceleration"]'
    ) as HTMLButtonElement;
    await act(async () => gpu.click());
    expect(gpu.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be changed"
    );
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
      '.v1-model-reasoning button[aria-label="High"]'
    ) as HTMLButtonElement;
    await act(async () => reasoning.click());
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
          'button[aria-label="Mint"]'
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
      look: {
        ...DEFAULT_AGENT_LOOK,
        palette: { ...DEFAULT_AGENT_LOOK.palette, base: "#55cca3" }
      }
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
    await render("services", vi.fn(), { initialPage: "health" });
    expect(
      container.querySelector('[aria-label="Service health"]')?.textContent
    ).toContain("APIHealthy");
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("Database unavailable");
    expect(container.textContent).toContain("Needs attention");
    expect(
      [...container.querySelectorAll("p")].filter((paragraph) =>
        paragraph.textContent?.startsWith("Updated ")
      )
    ).toHaveLength(1);
  });
  it("bounds startup refreshes and lets manual refresh start another window", async () => {
    vi.useFakeTimers();
    snapshot = {
      ...snapshot,
      status: {
        generatedAt: "2026-01-01T00:00:00Z",
        api: { state: "starting" }
      } as never
    };
    const listeners = new Set<() => void>();
    statusStore.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const refresh = vi.fn(async () => {
      snapshot = { ...snapshot, revision: snapshot.revision + 1 };
      for (const listener of listeners) listener();
      return snapshot.status;
    });
    statusStore.refresh = refresh;
    await render("services");
    const initialRequests = refresh.mock.calls.length;
    for (let tick = 0; tick < 40; tick++)
      await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(refresh).toHaveBeenCalledTimes(initialRequests + 40);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(refresh).toHaveBeenCalledTimes(initialRequests + 40);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Refresh status"]')!
        .click()
    );
    expect(refresh).toHaveBeenCalledTimes(initialRequests + 41);
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(refresh).toHaveBeenCalledTimes(initialRequests + 42);
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        .find((button) => button.textContent === "General")!
        .click()
    );
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(refresh).toHaveBeenCalledTimes(initialRequests + 42);
  });
  it("starts stopped services and opens logs through existing commands", async () => {
    snapshot = {
      ...snapshot,
      status: {
        generatedAt: "2026-01-01T00:00:00Z",
        api: { state: "needs_attention" }
      } as never
    };
    await render("services");
    await act(async () =>
      (
        container.querySelector(
          ".v1-service-actions .v1-settings-primary"
        ) as HTMLButtonElement
      ).click()
    );
    expect(run).toHaveBeenCalledWith("start");
    await act(async () =>
      (
        [...container.querySelectorAll(".v1-service-actions button")].find(
          (button) => button.textContent === "Open logs"
        ) as HTMLButtonElement
      ).click()
    );
    expect(run).toHaveBeenCalledWith("open_logs");
  });
  it("copies only allowlisted service states in diagnostics", async () => {
    snapshot = {
      ...snapshot,
      status: {
        generatedAt: "2026-01-01T00:00:00Z",
        api: { state: "healthy", message: "token=secret" },
        token: "secret"
      } as never
    };
    const writeText = vi.fn(async (value: string) => value.length);
    window.koedDesktop = { invoke: vi.fn(), clipboard: { writeText } } as never;
    await render("services");
    await act(async () =>
      (
        [...container.querySelectorAll(".v1-service-actions button")].find(
          (button) => button.textContent === "Copy diagnostics"
        ) as HTMLButtonElement
      ).click()
    );
    expect(writeText).toHaveBeenCalledOnce();
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain('"healthy"');
    expect(copied).not.toContain("secret");
    expect(container.textContent).toContain("Diagnostics copied.");
  });
  it("reports a restart stop failure without starting or claiming success", async () => {
    snapshot = {
      ...snapshot,
      status: {
        generatedAt: "2026-01-01T00:00:00Z",
        api: { state: "healthy" }
      } as never
    };
    const invoke = vi.fn(async () => ({ ok: false, message: "Stop failed" }));
    window.koedDesktop = { invoke } as never;
    await render("services");
    await act(async () =>
      (
        container.querySelector(
          ".v1-service-actions .v1-settings-primary"
        ) as HTMLButtonElement
      ).click()
    );
    expect(invoke).toHaveBeenCalledWith("stop");
    expect(run).not.toHaveBeenCalledWith("start");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Stop failed"
    );
  });
  it("opens command line as a nested page and returns to General on Escape", async () => {
    await render("general", vi.fn(), { initialPage: "cli" });
    expect(container.querySelector(".v1-settings-back")?.textContent).toBe(
      "General"
    );
    expect(container.querySelector(".v1-settings-body h3")?.textContent).toBe(
      "Command line"
    );
    expect(container.querySelector(".koed-setup-dialog")).toBeNull();
    expect(container.textContent).toContain(
      "Desktop installer bridge unavailable"
    );
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(container.querySelector(".v1-settings-body h3")?.textContent).toBe(
      "General"
    );
    const sections = [
      ...container.querySelectorAll(".v1-settings-body > section > h4")
    ].map((element) => element.textContent);
    expect(sections).toEqual(["On this device", "Optional tools"]);
  });

  it("keeps command-line installation alive while navigating away and shows verified completion", async () => {
    let finishInstall!: () => void;
    let installed = false;
    let pathConfigured = false;
    const api: NonNullable<ComponentProps<typeof V1Settings>["cliInstall"]> = {
      getStatus: async () => ({
        available: true,
        state: "not_installed",
        message: "Optional"
      }),
      subscribe: () => () => {},
      cancel: async () => {},
      selectOffline: async () => null,
      installPrivacy: vi.fn(),
      launcher: vi.fn<
        NonNullable<ComponentProps<typeof V1Settings>["cliInstall"]>["launcher"]
      >(async (operation) => {
        if (operation === "install") {
          await new Promise<void>((resolve) => {
            finishInstall = resolve;
          });
          installed = true;
        }
        return {
          ownership: installed ? "koed" : "absent",
          target: installed ? "valid" : "missing",
          template: installed ? "current" : null,
          helper: "supported",
          version: null,
          pathVisible: pathConfigured,
          pathConfigured,
          fingerprint: null
        };
      }),
      updatePath: vi.fn(async () => {
        pathConfigured = true;
      })
    };
    await render("general", vi.fn(), { cliInstall: api, initialPage: "cli" });
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Install command line")!
        .click()
    );
    await act(async () =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".v1-settings-nav button"
        )
      ]
        .find((button) => button.textContent === "Services")!
        .click()
    );
    await act(async () => finishInstall());
    await act(async () =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".v1-settings-nav button"
        )
      ]
        .find((button) => button.textContent === "General")!
        .click()
    );
    expect(
      container.querySelector('[data-settings-page="cli"]')?.textContent
    ).toContain("Installed");
    await act(async () =>
      (
        container.querySelector(
          '[data-settings-page="cli"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(container.textContent).toContain("Command line is ready");
    expect(api.launcher).toHaveBeenCalledWith("install", { consent: true });
    expect(api.updatePath).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".koed-setup-dialog")).toBeNull();
  });
  it("runs diagnostics through the desktop command and reports an unsuccessful result", async () => {
    run.mockResolvedValueOnce({ ok: false, error: "Database probe failed" });
    await render("services");
    await act(async () =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".v1-service-actions button"
        )
      ]
        .find((button) => button.textContent === "Run diagnostics")!
        .click()
    );
    expect(run).toHaveBeenCalledWith("doctor");
    expect(container.textContent).toContain("Database probe failed");
    expect(container.textContent).not.toContain("Diagnostics completed.");
  });
  it("does not present an old healthy snapshot as current after a refresh failure", async () => {
    snapshot = {
      ...snapshot,
      error: "Status refresh failed",
      status: {
        generatedAt: "2026-11-03T10:00:00Z",
        api: { state: "healthy" },
        embeddingState: null
      } as never
    };
    await render("services");
    expect(container.textContent).toContain("Status refresh failed");
    expect(container.textContent).toContain("Service status unavailable");
    expect(container.textContent).not.toContain("All services are healthy");
    expect(
      container.querySelector('[data-settings-page="embedding"]')
    ).not.toBeNull();
  });
  it("contains keyboard focus, supports arrow navigation, and restores the opener on close", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    await render();
    const general = container.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]'
    )!;
    expect(document.activeElement).toBe(general);
    await act(async () =>
      general.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Close settings"
    );
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true
        })
      )
    );
    expect(document.activeElement).toBe(general);
    await act(async () =>
      general.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true
        })
      )
    );
    expect(document.activeElement?.textContent).toBe("Your agent");
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
    ).toBe("Your agent");
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
