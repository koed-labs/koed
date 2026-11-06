// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopStatusStore,
  StatusSnapshot
} from "../services/desktop-commands.js";
import type { ThemeStore, ThemeSnapshot } from "../state/theme.js";
import { memoryModelFixture } from "./onboarding/memory-model.fixture.js";
import { V1Settings } from "./settings.js";

describe("V1Settings", () => {
  const container = document.body;
  let mount: HTMLDivElement;
  let root: Root;
  let snapshot: StatusSnapshot;
  let theme: ThemeSnapshot;
  let statusStore: DesktopStatusStore;
  let themeStore: ThemeStore;
  let run: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
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
    mount.remove();
    delete window.koedDesktop;
  });
  const render = async (
    initialTab: "general" | "agent" | "ai" | "services" = "general",
    overrides: Partial<ComponentProps<typeof V1Settings>> = {}
  ) => {
    await act(async () =>
      root.render(
        <V1Settings
          initialTab={initialTab}
          statusStore={statusStore}
          themeStore={themeStore}
          onClose={vi.fn()}
          {...overrides}
        />
      )
    );
  };
  it("writes theme through the existing ThemeStore", async () => {
    await render();
    await act(async () =>
      (
        container.querySelector(
          "[aria-label=Theme] button:nth-child(2)"
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
    await render("general", {
      launchAtStartup: launch,
      presentationPreferences: presentation,
      onRestartOnboarding: restart
    });
    const deviceSection = [...container.querySelectorAll("section")].find(
      (section) => section.querySelector("h3")?.textContent === "On this device"
    )!;
    for (const label of [
      "Open Koed at login",
      "Graphics acceleration",
      "Show Koed in the menu bar"
    ]) {
      const controls = container.querySelectorAll(
        `[role="switch"][aria-label="${label}"]`
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
      '[role="switch"][aria-label="Open Koed at login"]'
    ) as HTMLButtonElement;
    const gpu = container.querySelector(
      '[role="switch"][aria-label="Graphics acceleration"]'
    ) as HTMLButtonElement;
    const menu = container.querySelector(
      '[role="switch"][aria-label="Show Koed in the menu bar"]'
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
    await render("general", { presentationPreferences: presentation });
    const gpu = container.querySelector(
      '[role="switch"][aria-label="Graphics acceleration"]'
    ) as HTMLButtonElement;
    await act(async () => gpu.click());
    expect(gpu.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be changed"
    );
  });
  it("shows a single memory model for synthesis-capable clients and hides Conversation defaults", async () => {
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
          localSynthesis: {
            support: "supported",
            readiness: "ready"
          },
          models: [
            {
              id: "model-a",
              fullId: "openai/model-a",
              model: "model-a",
              displayName: "Model A",
              reasoningEfforts: ["medium", "high"]
            }
          ]
        }
      ],
      settings: [],
      defaults: {
        ...Object.fromEntries(
          [
            "mcp_memory_answer",
            "lcm_summary",
            "session_title",
            "curated_memory_review"
          ].map((key) => [
            key,
            { available: true, persistable: true, assignment }
          ])
        )
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
    await render("ai", { localAiClients });
    expect(container.textContent).toContain("Memory Model");
    expect(container.textContent).not.toContain("New Conversations");
    expect(
      container.querySelector('[aria-label="AI Client"]')?.textContent
    ).toContain("Codex");
    expect(container.querySelector('[aria-label="Model"]')?.textContent).toBe(
      "Model A"
    );
    expect(localAiClients.set).not.toHaveBeenCalled();
  });
  it("can replace an incomplete Pi default with Codex and retain each task’s limits", async () => {
    const api = {
      ...memoryModelFixture(() => ["codex"]),
      set: vi.fn(),
      reset: vi.fn()
    };
    const save = vi.spyOn(api, "setMemoryModel");
    await render("ai", { localAiClients: api });
    const client = container.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="AI Client"]'
    )!;
    expect(client.disabled).toBe(false);
    await act(async () =>
      client.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      )
    );
    const option = [
      ...container.querySelectorAll<HTMLElement>('[role="option"]')
    ].find((o) => o.textContent === "Codex")!;
    await act(async () => option.click());
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Save Memory Model"
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        limits: {
          mcp_memory_answer: { timeout_ms: 1800000, max_attempts: 2 },
          lcm_summary: { timeout_ms: 240000, max_attempts: 4 },
          session_title: { timeout_ms: 240000, max_attempts: 4 },
          curated_memory_review: { timeout_ms: 90000, max_attempts: 2 }
        }
      })
    );
    expect(container.textContent).toContain(
      "Memory Model saved for all four tasks."
    );
  });
  it("opens General for an old Your agent navigation entry", async () => {
    await render("agent");
    const selected = container.querySelector(
      '[role="tab"][aria-selected="true"]'
    );
    expect(selected?.textContent).toBe("General");
    expect(container.textContent).not.toContain("Your agent");
    expect(container.querySelector(".v1-look-picker")).toBeNull();
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
        ...container.querySelectorAll(".client-row:first-child button")
      ].find((b) => b.textContent?.includes("Connect")) as HTMLButtonElement;
      connect.click();
    });
    expect(run).not.toHaveBeenCalled();
    expect(
      container.querySelector('.v1-settings-confirm[role="dialog"]')
    ).not.toBeNull();
    await act(async () =>
      (
        container.querySelector(
          ".v1-settings-confirm [data-slot=dialog-footer] button:last-child"
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
    await render("services", { initialPage: "health" });
    expect(container.querySelector(".group-card")?.textContent).toContain(
      "APIHealthy"
    );
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("Database unavailable");
    expect(container.textContent).toContain("Needs attention");
    expect(
      [...container.querySelectorAll(".service-footer [role=status]")].filter(
        (paragraph) => paragraph.textContent?.startsWith("Updated ")
      )
    ).toHaveLength(1);
  });
  it.each(["health", "embedding"] as const)(
    "keeps service actions on the overview when navigating into %s and back",
    async (page) => {
      snapshot = {
        ...snapshot,
        status: { embeddingState: null } as never
      };
      await render("services");
      expect(container.textContent).toContain("Service actions");
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(`[data-settings-page="${page}"]`)!
          .click()
      );
      expect(container.textContent).not.toContain("Service actions");
      expect(container.textContent).not.toContain("Run diagnostics");
      expect(
        container.querySelector('[aria-label="Refresh status"]')
      ).not.toBeNull();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Back to Services"]')!
          .click()
      );
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Service actions")
      );
    }
  );
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
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Start Koed")!
        .click()
    );
    expect(run).toHaveBeenCalledWith("start");
    await act(async () =>
      (
        [...container.querySelectorAll(".group-card button")].find(
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
        [...container.querySelectorAll(".group-card button")].find(
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
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Restart Koed")!
        .click()
    );
    expect(invoke).toHaveBeenCalledWith("stop");
    expect(run).not.toHaveBeenCalledWith("start");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Stop failed"
    );
  });
  it("opens command line as a nested page and returns to General on Escape", async () => {
    await render("general", { initialPage: "cli" });
    expect(container.querySelector(".page-heading .back")?.textContent).toBe(
      "General"
    );
    expect(container.querySelector(".page-heading h2")?.textContent).toBe(
      "Command line"
    );
    expect(container.querySelector(".koed-setup-dialog")).toBeNull();
    expect(container.textContent).toContain(
      "Desktop installer bridge unavailable"
    );
    await act(async () =>
      document
        .querySelector(".v1-settings-popup")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        )
    );
    expect(container.querySelector(".page-heading h2")?.textContent).toBe(
      "General"
    );
    const sections = [
      ...container.querySelectorAll(".settings-scroll > section > h3")
    ].map((element) => element.textContent);
    expect(sections).toEqual([
      "Appearance",
      "On this device",
      "Optional tools"
    ]);
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
    await render("general", { cliInstall: api, initialPage: "cli" });
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Install command line")!
        .click()
    );
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>(".settings-nav button")]
        .find((button) => button.textContent === "Services")!
        .click()
    );
    await act(async () => finishInstall());
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>(".settings-nav button")]
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
      [...container.querySelectorAll<HTMLButtonElement>(".group-card button")]
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
  it("selects and focuses the next sidebar tab using an arrow key", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    await render();
    const general = container.querySelector<HTMLButtonElement>(
      '[role="tab"][aria-selected="true"]'
    )!;
    await act(async () =>
      general.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true
        })
      )
    );
    expect(document.activeElement?.textContent).toBe("AI models");
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
    ).toBe("AI models");
    await act(async () => root.render(null));
    opener.remove();
  });
});
