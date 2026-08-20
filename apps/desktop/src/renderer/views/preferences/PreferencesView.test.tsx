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

const integrationConsentCases = [
  {
    action: "setup_codex",
    button: "Set up Codex integration",
    title: "Set up the Codex integration?",
    description:
      "Koed will add its marked Codex integration block and Supported Capture Hook. Unrelated settings, credentials, and other clients remain untouched.",
    confirmLabel: "Set up Codex"
  },
  {
    action: "repair_codex",
    button: "Repair Codex integration",
    title: "Repair the Codex integration?",
    description:
      "Koed will replace only its marked Codex integration block and Supported Capture Hook. Unrelated settings and credentials remain untouched.",
    confirmLabel: "Repair Codex"
  },
  {
    action: "remove_codex",
    button: "Remove Codex integration",
    title: "Remove the Codex integration?",
    description:
      "Koed will remove only its marked Codex integration block. Unrelated settings and credentials remain untouched.",
    confirmLabel: "Remove Codex"
  },
  {
    action: "setup_claude",
    button: "Set up Claude Code integration",
    title: "Set up the Claude Code integration?",
    description:
      "Koed will add its MCP Server and Supported Capture Hook to Claude Code settings, or remove only those Koed-owned entries. It preserves unrelated settings, hooks, and provider credentials.",
    confirmLabel: "Set up Claude Code"
  },
  {
    action: "repair_claude",
    button: "Repair Claude Code integration",
    title: "Repair the Claude Code integration?",
    description:
      "Koed will replace only its MCP Server and Supported Capture Hook entries in Claude Code. Unrelated settings, hooks, and provider credentials remain untouched.",
    confirmLabel: "Repair Claude Code"
  },
  {
    action: "remove_claude",
    button: "Remove Claude Code integration",
    title: "Remove the Claude Code integration?",
    description:
      "Koed will remove only its owned MCP Server and Supported Capture Hook entries. Unrelated settings, hooks, and provider credentials remain untouched.",
    confirmLabel: "Remove Claude Code"
  },
  {
    action: "setup_pi",
    button: "Set up Pi integration",
    title: "Set up the Pi integration?",
    description:
      "Koed will register its local package in your active global Pi profile, or remove only that Koed-owned package. It preserves unrelated Pi settings, packages, and provider credentials.",
    confirmLabel: "Set up Pi"
  },
  {
    action: "repair_pi",
    button: "Repair Pi integration",
    title: "Repair the Pi integration?",
    description:
      "Koed will replace only its package in the active Pi profile. Unrelated packages, settings, and provider credentials remain untouched.",
    confirmLabel: "Repair Pi"
  },
  {
    action: "remove_pi",
    button: "Remove Pi integration",
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
      version: "0.4.4",
      ...overrides
    };
    await act(async () => root.render(<PreferencesView {...props} />));
    return props;
  };

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
    ).toEqual([
      "General",
      "AI Clients",
      "Team Connection",
      "About",
      "Advanced Diagnostics"
    ]);
    expect(container.querySelector(".koed-local-ai-settings")).toBeTruthy();

    await renderPreferences({ initialSection: "advanced", localAiClients });
    expect(container.querySelector(".koed-local-ai-settings")).toBeNull();
    expect(container.textContent).not.toContain(
      "Opening saved AI Client settings"
    );
  });

  it("keeps Operator diagnostics collapsed and excludes credential values", async () => {
    await renderPreferences({ initialSection: "advanced" });
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(container.textContent).toContain(
      "do not expose API Token values or remote credentials"
    );
    expect(container.textContent).not.toContain("sk-");
  });

  it("refreshes a stale startup snapshot when Advanced Diagnostics opens", async () => {
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
    async ({ action, button, title, description, confirmLabel }) => {
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

      await renderPreferences({ initialSection: "advanced" });
      await vi.waitFor(() =>
        expect(
          [...container.querySelectorAll("button")].find(
            (item) => item.textContent?.trim() === button
          )
        ).toBeTruthy()
      );
      await clickButton(container, button);

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
    await renderPreferences({ initialSection: "advanced", statusStore });

    await clickButton(container, "Set up Claude Code integration");
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
    await renderPreferences({ initialSection: "advanced", statusStore });

    await clickButton(container, "Set up Pi integration");
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
