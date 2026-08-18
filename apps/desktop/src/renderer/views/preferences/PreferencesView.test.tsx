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
