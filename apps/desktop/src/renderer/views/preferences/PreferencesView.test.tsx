// @vitest-environment happy-dom

import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { DesktopApi, KoedServerStatus } from "../../../types.js";
import { DesktopStatusStore } from "../../services/desktop-commands.js";
import { PreferencesView } from "./PreferencesView.js";

const clickButton = async (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
};

const clickClientCardButton = async (
  container: HTMLElement,
  clientLabel: string,
  buttonLabel: string
) => {
  const card = [...container.querySelectorAll(".koed-client-card")].find(
    (item) => item.querySelector("strong")?.textContent === clientLabel
  );
  expect(card).toBeTruthy();
  const button = [...card!.querySelectorAll("button")].find(
    (item) =>
      item.textContent?.trim() === buttonLabel ||
      item.getAttribute("aria-label") === `${buttonLabel} ${clientLabel}`
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
};

const snapshot = {
  connection: {
    state: "live",
    backendId: "backend-a",
    connectedAt: "2026-07-23T00:00:00.000Z",
    retryAt: null,
    reconnectAttempt: 0,
    protocolVersion: 1
  }
} as unknown as CollaborationSnapshot;

const advancedStatus = (
  overrides: Partial<KoedServerStatus> = {}
): KoedServerStatus => {
  const healthy = { state: "healthy" as const };
  return {
    ok: true,
    state: "healthy",
    serverPackage: healthy,
    api: { ...healthy, url: "http://127.0.0.1:43300" },
    database: healthy,
    redis: healthy,
    workerQueues: healthy,
    embeddingService: healthy,
    privacyService: healthy,
    localAiRuntime: healthy,
    apiToken: { ...healthy, configured: true },
    mcpServer: healthy,
    captureHook: healthy,
    codex: { ...healthy, configured: true },
    claudeCode: { ...healthy, configured: true },
    pi: { ...healthy, configured: true },
    lcmSummaryService: healthy,
    personalDeviceSync: healthy,
    upstreamBackends: {
      ...healthy,
      registered: 0,
      validated: 0,
      stale: 0,
      failed: 0,
      notChecked: 0
    },
    lastVerification: { ...healthy, checkedAt: null },
    koedHome: "/tmp/koed",
    generatedAt: "2026-08-28T00:00:00.000Z",
    runtimeMode: "local-personal",
    dependencyMode: "bundled-local",
    ...overrides
  };
};

const integrationConsentCases = [
  {
    action: "setup_codex",
    clientLabel: "Codex",
    button: "Set up",
    title: "Set up the Codex integration?",
    description:
      "Koed will add its marked Codex integration block and Supported Capture Hook. Unrelated settings, credentials, and other clients remain untouched.",
    confirmLabel: "Set up Codex"
  },
  {
    action: "repair_codex",
    clientLabel: "Codex",
    button: "Repair",
    title: "Repair the Codex integration?",
    description:
      "Koed will replace only its marked Codex integration block and Supported Capture Hook. Unrelated settings and credentials remain untouched.",
    confirmLabel: "Repair Codex"
  },
  {
    action: "remove_codex",
    clientLabel: "Codex",
    button: "Remove",
    title: "Remove the Codex integration?",
    description:
      "Koed will remove only its marked Codex integration block. Unrelated settings and credentials remain untouched.",
    confirmLabel: "Remove Codex"
  },
  {
    action: "setup_claude",
    clientLabel: "Claude Code",
    button: "Set up",
    title: "Set up the Claude Code integration?",
    description:
      "Koed will add its MCP Server and Supported Capture Hook to Claude Code settings, or remove only those Koed-owned entries. It preserves unrelated settings, hooks, and provider credentials.",
    confirmLabel: "Set up Claude Code"
  },
  {
    action: "repair_claude",
    clientLabel: "Claude Code",
    button: "Repair",
    title: "Repair the Claude Code integration?",
    description:
      "Koed will replace only its MCP Server and Supported Capture Hook entries in Claude Code. Unrelated settings, hooks, and provider credentials remain untouched.",
    confirmLabel: "Repair Claude Code"
  },
  {
    action: "remove_claude",
    clientLabel: "Claude Code",
    button: "Remove",
    title: "Remove the Claude Code integration?",
    description:
      "Koed will remove only its owned MCP Server and Supported Capture Hook entries. Unrelated settings, hooks, and provider credentials remain untouched.",
    confirmLabel: "Remove Claude Code"
  },
  {
    action: "setup_pi",
    clientLabel: "Pi",
    button: "Set up",
    title: "Set up the Pi integration?",
    description:
      "Koed will register its local package in your active global Pi profile, or remove only that Koed-owned package. It preserves unrelated Pi settings, packages, and provider credentials.",
    confirmLabel: "Set up Pi"
  },
  {
    action: "repair_pi",
    clientLabel: "Pi",
    button: "Repair",
    title: "Repair the Pi integration?",
    description:
      "Koed will replace only its package in the active Pi profile. Unrelated packages, settings, and provider credentials remain untouched.",
    confirmLabel: "Repair Pi"
  },
  {
    action: "remove_pi",
    clientLabel: "Pi",
    button: "Remove",
    title: "Remove the Pi integration?",
    description:
      "Koed will remove only its package from the active Pi profile and preserve unrelated packages, settings, and provider credentials.",
    confirmLabel: "Remove Pi"
  }
] as const;

describe("PreferencesView", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    window.koedDesktop = { invoke: vi.fn() };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete window.koedDesktop;
  });

  const renderPreferences = async (
    overrides: Partial<React.ComponentProps<typeof PreferencesView>> = {}
  ) => {
    const props: React.ComponentProps<typeof PreferencesView> = {
      onThemeChange: vi.fn(),
      statusStore: new DesktopStatusStore(),
      theme: "system",
      version: "test-desktop-version",
      ...overrides
    };
    await act(async () => root.render(<PreferencesView {...props} />));
    return props;
  };

  it("renders the supplied Desktop application version in About", async () => {
    await renderPreferences({
      initialSection: "about",
      version: "9.8.7-test"
    });

    expect(container.textContent).toContain("Version");
    expect(container.textContent).toContain("9.8.7-test");
  });

  it("delegates theme persistence to the trusted parent", async () => {
    const onThemeChange = vi.fn();
    await renderPreferences({ onThemeChange });
    const dark = container.querySelector<HTMLInputElement>(
      'input[name="theme"][value="dark"]'
    );
    expect(dark).toBeTruthy();
    await act(async () => dark!.click());
    expect(onThemeChange).toHaveBeenCalledWith("dark");
  });

  it("persists the hardware acceleration toggle through trusted Desktop IPC", async () => {
    const get = vi.fn(async () => ({
      enabled: true,
      managedByEnvironment: false
    }));
    const set = vi.fn(async (enabled: boolean) => ({
      enabled,
      managedByEnvironment: false
    }));
    await renderPreferences({ hardwareAcceleration: { get, set } });
    const toggle = container.querySelector<HTMLInputElement>(
      'input[aria-label="Hardware acceleration"]'
    );
    expect(toggle).toBeTruthy();
    expect(toggle!.checked).toBe(true);

    await act(async () => toggle!.click());

    expect(set).toHaveBeenCalledWith(false);
    expect(toggle!.checked).toBe(false);
  });

  it("disables hardware acceleration controlled by the Operator environment", async () => {
    await renderPreferences({
      hardwareAcceleration: {
        get: vi.fn(async () => ({
          enabled: true,
          managedByEnvironment: true
        })),
        set: vi.fn()
      }
    });
    const toggle = container.querySelector<HTMLInputElement>(
      'input[aria-label="Hardware acceleration"]'
    );
    expect(toggle!.disabled).toBe(true);
    expect(container.textContent).toContain("managed by the Operator");
  });

  it("persists launch at startup through trusted Desktop IPC", async () => {
    const get = vi.fn(async () => ({
      enabled: false,
      status: "disabled" as const,
      supported: true
    }));
    const set = vi.fn(async (enabled: boolean) => ({
      enabled,
      status: enabled ? ("enabled" as const) : ("disabled" as const),
      supported: true
    }));
    await renderPreferences({ launchAtStartup: { get, set } });
    const toggle = container.querySelector<HTMLInputElement>(
      'input[aria-label="Launch Koed at startup"]'
    );

    expect(toggle).toBeTruthy();
    expect(toggle!.checked).toBe(false);
    await act(async () => toggle!.click());

    expect(set).toHaveBeenCalledWith(true);
    expect(toggle!.checked).toBe(true);
    expect(container.textContent).toContain(
      "Start Koed in the background when you sign in."
    );
  });

  it("surfaces approval and unavailable launch-at-startup states", async () => {
    await renderPreferences({
      launchAtStartup: {
        get: vi.fn(async () => ({
          enabled: true,
          status: "requires-approval" as const,
          supported: true
        })),
        set: vi.fn()
      }
    });
    expect(container.textContent).toContain(
      "Allow Koed in System Settings to finish setup."
    );

    await renderPreferences({
      launchAtStartup: {
        get: vi.fn(async () => ({
          enabled: false,
          status: "unsupported" as const,
          supported: false
        })),
        set: vi.fn()
      }
    });
    const toggle = container.querySelector<HTMLInputElement>(
      'input[aria-label="Launch Koed at startup"]'
    );
    expect(toggle!.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Available in a packaged Koed app."
    );
  });

  it("reverts launch at startup when the OS update fails", async () => {
    await renderPreferences({
      launchAtStartup: {
        get: vi.fn(async () => ({
          enabled: false,
          status: "disabled" as const,
          supported: true
        })),
        set: vi.fn(async () => {
          throw new Error("denied");
        })
      }
    });
    const toggle = container.querySelector<HTMLInputElement>(
      'input[aria-label="Launch Koed at startup"]'
    );

    await act(async () => toggle!.click());

    expect(toggle!.checked).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be changed"
    );
  });

  it("hides Capture until the Desktop integration is available", async () => {
    await renderPreferences();
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Capture"
      )
    ).toBe(false);
    expect(container.querySelector('[aria-label="Capture State"]')).toBeNull();

    await renderPreferences({ initialSection: "capture" });
    expect(
      container.querySelector("#koed-preference-section-title")?.textContent
    ).toBe("General");
  });

  it("connects to an explicit remote URL and confirms removal in a Dialog", async () => {
    const connectRemote = vi.fn(async () => snapshot);
    const disconnect = vi.fn(async () => snapshot);
    const client = {
      currentRemoteUrl: () => "https://team.koed.example",
      connectRemote,
      disconnect,
      reconnect: vi.fn(async () => snapshot)
    } as unknown as CollaborationRendererClient;

    await renderPreferences({
      collaborationClient: client,
      collaborationSnapshot: snapshot,
      initialSection: "team-connection"
    });
    const input = container.querySelector(
      'input[type="url"]'
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "https://other.koed.example");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const form = container.querySelector("form")!;
    await act(async () =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
    );
    expect(connectRemote).toHaveBeenCalledWith({
      remoteUrl: "https://other.koed.example"
    });

    await clickButton(container, "Remove connection");
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Remove Team Connection?");
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("keeps AI Client settings in their own configuration section", async () => {
    const emptyDefault = {
      source: "code",
      available: false,
      assignment: null,
      reason: "No configured AI Client."
    };
    const localAiClients = {
      list: vi.fn(async () => ({
        operation: "list",
        readModel: {
          instances: [],
          capabilitySnapshots: [],
          settings: [],
          defaults: {
            mcp_memory_answer: emptyDefault,
            lcm_summary: emptyDefault,
            session_title: emptyDefault,
            curated_memory_review: emptyDefault
          }
        }
      })),
      refresh: vi.fn(),
      set: vi.fn(),
      reset: vi.fn()
    } as unknown as DesktopApi["localAiClients"];

    await renderPreferences({ initialSection: "ai-clients", localAiClients });
    expect(
      [...container.querySelectorAll("nav button")].map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(["General", "Agents", "Teams", "Services", "About"]);
    expect(container.querySelector(".koed-local-ai-settings")).toBeTruthy();

    await renderPreferences({ initialSection: "advanced", localAiClients });
    expect(container.querySelector(".koed-local-ai-settings")).toBeNull();
    expect(container.textContent).not.toContain(
      "Opening saved AI Client settings"
    );
  });

  it("hides Team preferences when Team collaboration is disabled", async () => {
    await renderPreferences({
      initialSection: "team-connection",
      teamCollaborationEnabled: false
    });

    expect(
      [...container.querySelectorAll("nav button")].map((button) =>
        button.textContent?.trim()
      )
    ).toEqual(["General", "Agents", "Services", "About"]);
    expect(container.textContent).not.toContain("Remote Team Backend URL");
    expect(container.querySelector("[aria-current='page']")?.textContent).toBe(
      "General"
    );
  });

  it("renders concise connection states and icon-only actions", async () => {
    const component = { state: "healthy" as const };
    const status = advancedStatus({
      codex: {
        ...component,
        configured: true,
        message: "The integration is configured."
      },
      claudeCode: {
        state: "not_configured",
        configured: false,
        message: "A lengthy setup diagnostic should not be shown."
      },
      pi: {
        state: "needs_attention",
        configured: true,
        message: "A lengthy startup diagnostic should not be shown."
      },
      aiClients: {
        codex: {
          driverId: "codex",
          instanceId: "codex.default",
          displayName: "Codex",
          installed: component,
          version: "1.2.3",
          authentication: "authenticated",
          profile: component,
          capabilities: [],
          observedAt: "2026-08-28T00:00:00.000Z",
          snapshotState: "current"
        },
        claude: {
          driverId: "claude",
          instanceId: "claude.default",
          displayName: "Claude Code",
          installed: { state: "not_configured" },
          version: null,
          authentication: "unknown",
          profile: { state: "not_configured" },
          capabilities: [],
          observedAt: "2026-08-28T00:00:00.000Z",
          snapshotState: "unknown"
        },
        pi: {
          driverId: "pi",
          instanceId: "pi.default",
          displayName: "Pi",
          installed: component,
          version: null,
          authentication: "unknown",
          profile: { state: "needs_attention" },
          capabilities: [],
          observedAt: "2026-08-28T00:00:00.000Z",
          snapshotState: "current"
        }
      }
    });
    window.koedDesktop = {
      invoke: vi.fn(async (command) =>
        command === "status" ? status : { ok: true }
      )
    } as DesktopApi;

    await renderPreferences({ initialSection: "ai-clients" });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Connections")
    );
    expect(container.textContent).not.toContain(
      "Manage each client's Koed integration independently"
    );
    expect(container.textContent).not.toContain(
      "The integration is configured."
    );
    expect(container.textContent).not.toContain(
      "A lengthy setup diagnostic should not be shown."
    );
    expect(container.textContent).not.toContain(
      "A lengthy startup diagnostic should not be shown."
    );
    expect(container.textContent).toContain("Not installed");
    expect(container.textContent).toContain("Could not be started");
    expect(container.textContent).not.toContain(
      "Version unknown · Auth unknown"
    );

    const codexCard = [...container.querySelectorAll(".koed-client-card")].find(
      (card) => card.querySelector("strong")?.textContent === "Codex"
    )!;
    expect(codexCard.querySelectorAll("button")).toHaveLength(3);
    expect(
      [...codexCard.querySelectorAll("button")].every(
        (button) => button.textContent?.trim() === ""
      )
    ).toBe(true);
    expect(
      codexCard.querySelector(
        'button[aria-label="Repair Codex"] .lucide-wrench'
      )
    ).toBeTruthy();
    expect(
      codexCard.querySelector(
        'button[aria-label="Check Codex"] .lucide-refresh-cw'
      )
    ).toBeTruthy();
    expect(
      codexCard.querySelector(
        'button[aria-label="Remove Codex"] .lucide-trash-2'
      )
    ).toBeTruthy();
    expect(
      container.querySelector(
        'button[aria-label="Set up Claude Code"] .lucide-play'
      )
    ).toBeTruthy();
  });

  it("summarizes healthy diagnostics and keeps icon actions accessible", async () => {
    const status = advancedStatus();
    window.koedDesktop = {
      invoke: vi.fn(async (command) =>
        command === "status" ? status : { ok: true }
      )
    } as DesktopApi;

    await renderPreferences({ initialSection: "advanced" });
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("All services are healthy")
    );
    expect(container.textContent).not.toContain(
      "Operator diagnostics describe local implementation detail"
    );
    expect(
      container.querySelector(
        '.koed-diagnostics-summary-status[data-state="healthy"] .lucide-circle-check'
      )
    ).toBeTruthy();
    const actions = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".koed-diagnostic-actions button"
      )
    ];
    expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Refresh status",
      "Run diagnostics",
      "Open logs"
    ]);
    expect(actions.every((button) => button.textContent?.trim() === "")).toBe(
      true
    );
    expect(container.textContent).not.toContain("sk-");
  });

  it("keeps the Refresh action fixed while showing operational progress", async () => {
    const status = advancedStatus();
    let statusCalls = 0;
    let resolveRefresh!: (value: KoedServerStatus) => void;
    const refreshPending = new Promise<KoedServerStatus>((resolve) => {
      resolveRefresh = resolve;
    });
    window.koedDesktop = {
      invoke: vi.fn(async (command) => {
        if (command !== "status") return { ok: true };
        statusCalls += 1;
        return statusCalls === 1 ? status : refreshPending;
      })
    } as DesktopApi;

    await renderPreferences({ initialSection: "advanced" });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("All services are healthy")
    );
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh status"]'
    )!;
    const fixedWidthClasses = refresh.className;

    await act(async () => refresh.click());
    await vi.waitFor(() =>
      expect(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Refreshing status"]'
        )
      ).toBeTruthy()
    );
    const refreshing = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refreshing status"]'
    )!;
    expect(refreshing.className).toBe(fixedWidthClasses);
    expect(refreshing.disabled).toBe(true);
    expect(refreshing.getAttribute("aria-busy")).toBe("true");
    expect(refreshing.querySelector("svg.animate-spin")).toBeTruthy();

    await act(async () => resolveRefresh(status));
    await vi.waitFor(() =>
      expect(
        container.querySelector('button[aria-label="Refresh status"]')
      ).toBeTruthy()
    );
  });

  it("keeps the Run Diagnostics action fixed while showing operational progress", async () => {
    const status = advancedStatus();
    let resolveDoctor!: (value: { ok: true }) => void;
    const doctorPending = new Promise<{ ok: true }>((resolve) => {
      resolveDoctor = resolve;
    });
    window.koedDesktop = {
      invoke: vi.fn(async (command) => {
        if (command === "status") return status;
        if (command === "doctor") return doctorPending;
        return { ok: true };
      })
    } as DesktopApi;

    await renderPreferences({ initialSection: "advanced" });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("All services are healthy")
    );
    const doctor = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Run diagnostics"]'
    )!;
    const fixedWidthClasses = doctor.className;

    await act(async () => doctor.click());
    await vi.waitFor(() =>
      expect(
        container.querySelector<HTMLButtonElement>(
          'button[aria-label="Running diagnostics"]'
        )
      ).toBeTruthy()
    );
    const running = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Running diagnostics"]'
    )!;
    expect(running.className).toBe(fixedWidthClasses);
    expect(running.disabled).toBe(true);
    expect(running.getAttribute("aria-busy")).toBe("true");
    expect(running.querySelector("svg.animate-spin")).toBeTruthy();

    await act(async () => resolveDoctor({ ok: true }));
    await vi.waitFor(() =>
      expect(
        container.querySelector('button[aria-label="Run diagnostics"]')
      ).toBeTruthy()
    );
  });

  it("counts unhealthy services and only shows detail for their rows", async () => {
    const status = advancedStatus({
      serverPackage: {
        state: "healthy",
        message: "This healthy detail should stay hidden."
      },
      api: {
        state: "needs_attention",
        message: "The API did not respond.",
        url: "http://127.0.0.1:43300"
      }
    });
    window.koedDesktop = {
      invoke: vi.fn(async (command) =>
        command === "status" ? status : { ok: true }
      )
    } as DesktopApi;

    await renderPreferences({ initialSection: "advanced" });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("1/9 services need attention")
    );
    expect(
      container.querySelector(
        '.koed-diagnostics-summary-status[data-state="needs_attention"] .lucide-circle-alert'
      )
    ).toBeTruthy();

    const rows = [...container.querySelectorAll(".koed-diagnostics dl > div")];
    const row = (label: string) =>
      rows.find((item) => item.querySelector("dt")?.textContent === label)!;
    const healthyDetail = row("Server package").querySelector("dd")!;
    expect(healthyDetail.textContent).toBe("Healthy");
    expect(container.textContent).not.toContain(
      "This healthy detail should stay hidden."
    );
    expect(row("API").querySelector("dd")?.textContent).toBe(
      "needs attentionThe API did not respond."
    );
  });

  it("refreshes a stale startup snapshot when Services opens", async () => {
    vi.useFakeTimers();
    const healthy = { state: "healthy" as const };
    const starting = { state: "starting" as const };
    const base = {
      ok: true,
      state: "healthy",
      serverPackage: healthy,
      api: { ...healthy, url: "http://127.0.0.1:43300" },
      database: healthy,
      workerQueues: healthy,
      embeddingService: healthy,
      mcpServer: healthy,
      captureHook: healthy,
      codex: { ...healthy, configured: true },
      claudeCode: { ...healthy, configured: true },
      pi: { ...healthy, configured: true },
      lcmSummaryService: healthy
    } as KoedServerStatus;
    const stale = {
      ...base,
      api: { ...starting, url: "http://127.0.0.1:43300" },
      database: starting,
      workerQueues: starting,
      embeddingService: starting,
      mcpServer: { state: "needs_attention" as const },
      lcmSummaryService: { state: "needs_attention" as const }
    };
    const invoke = vi
      .fn<DesktopApi["invoke"]>()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(base);
    window.koedDesktop = { invoke } as DesktopApi;
    const statusStore = new DesktopStatusStore();
    await statusStore.refresh();

    await renderPreferences({ initialSection: "advanced", statusStore });

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(container.textContent).not.toContain("Starting");
    expect(container.textContent).not.toContain("Needs Attention");
    vi.useRealTimers();
  });

  it.each(integrationConsentCases)(
    "renders exact consent and passes operator consent for $action",
    async ({
      action,
      clientLabel,
      button,
      title,
      description,
      confirmLabel
    }) => {
      const component = { state: "healthy" as const };
      const targetState = action.startsWith("setup_")
        ? ("not_configured" as const)
        : ("healthy" as const);
      const target = {
        state: targetState,
        configured: targetState === "healthy"
      };
      const status = {
        ok: true,
        state: "healthy",
        serverPackage: component,
        api: { ...component, url: "http://127.0.0.1:3300" },
        database: component,
        workerQueues: component,
        embeddingService: component,
        mcpServer: component,
        captureHook: component,
        codex: action.endsWith("codex")
          ? target
          : { ...component, configured: true },
        claudeCode: action.endsWith("claude")
          ? target
          : { ...component, configured: true },
        pi: action.endsWith("pi") ? target : { ...component, configured: true },
        lcmSummaryService: component
      } as KoedServerStatus;
      const invoke = vi
        .fn<DesktopApi["invoke"]>()
        .mockImplementation(async (command) => {
          if (command === "status") return status;
          return { ok: true };
        });
      window.koedDesktop = { invoke } as DesktopApi;

      await renderPreferences({ initialSection: "ai-clients" });
      await vi.waitFor(() =>
        expect(
          [...container.querySelectorAll(".koed-client-card")].find(
            (item) => item.querySelector("strong")?.textContent === clientLabel
          )
        ).toBeTruthy()
      );
      await clickClientCardButton(container, clientLabel, button);

      const dialog =
        document.body.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(
        dialog?.querySelector('[data-slot="dialog-title"]')?.textContent
      ).toBe(title);
      expect(
        dialog?.querySelector('[data-slot="dialog-description"]')?.textContent
      ).toBe(description);
      const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
        (item) => item.textContent?.trim() === confirmLabel
      );
      expect(confirm?.textContent?.trim()).toBe(confirmLabel);
      if (action.startsWith("remove_")) {
        expect(dialog?.textContent).not.toMatch(/set up/i);
      }

      await clickButton(dialog!, confirmLabel);
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(action, {
          operatorConsented: true
        })
      );
    }
  );

  it("confirms Claude Code user-settings changes before setup", async () => {
    const component = { state: "healthy" as const };
    const status = {
      ok: true,
      state: "healthy",
      serverPackage: component,
      api: { ...component, url: "http://127.0.0.1:3300" },
      database: component,
      workerQueues: component,
      embeddingService: component,
      mcpServer: component,
      captureHook: component,
      codex: { ...component, configured: true },
      claudeCode: { state: "not_configured", configured: false },
      pi: { ...component, configured: true },
      lcmSummaryService: component
    } as KoedServerStatus;
    const invoke = vi
      .fn<DesktopApi["invoke"]>()
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ...status,
        claudeCode: { ...component, configured: true }
      });
    window.koedDesktop = { invoke } as DesktopApi;
    const statusStore = new DesktopStatusStore();
    await statusStore.refresh();
    await renderPreferences({ initialSection: "ai-clients", statusStore });

    await clickClientCardButton(container, "Claude Code", "Set up");
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      "add its MCP Server and Supported Capture Hook"
    );
    expect(invoke).toHaveBeenCalledTimes(2);

    await clickButton(dialog!, "Set up Claude Code");
    await vi.waitFor(() =>
      expect(invoke.mock.calls.map(([command]) => command)).toEqual([
        "status",
        "status",
        "setup_claude",
        "status"
      ])
    );
  });

  it("confirms the global profile change before setting up Pi", async () => {
    const component = { state: "healthy" as const };
    const status = {
      ok: true,
      state: "healthy",
      serverPackage: component,
      api: { ...component, url: "http://127.0.0.1:3300" },
      database: component,
      workerQueues: component,
      embeddingService: component,
      mcpServer: component,
      captureHook: component,
      codex: { ...component, configured: true },
      pi: { state: "not_configured", configured: false },
      lcmSummaryService: component
    } as KoedServerStatus;
    const invoke = vi
      .fn<DesktopApi["invoke"]>()
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ...status,
        pi: { ...component, configured: true }
      });
    window.koedDesktop = { invoke } as DesktopApi;
    const statusStore = new DesktopStatusStore();
    await statusStore.refresh();
    await renderPreferences({ initialSection: "ai-clients", statusStore });

    await clickClientCardButton(container, "Pi", "Set up");
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      "register its local package in your active global Pi profile"
    );
    expect(invoke).toHaveBeenCalledTimes(2);

    await clickButton(dialog!, "Set up Pi");
    await vi.waitFor(() =>
      expect(invoke.mock.calls.map(([command]) => command)).toEqual([
        "status",
        "status",
        "setup_pi",
        "status"
      ])
    );
  });
});
