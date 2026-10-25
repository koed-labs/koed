// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, KoedServerStatus } from "../../../types.js";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import type { LocalAiClientResponse } from "../../../ipc/local-ai-client-protocol.js";
import { DesktopStatusStore } from "../../services/desktop-commands.js";
import { flows } from "../../views/preferences/local-ai-client-settings-helpers.js";
import {
  HqSettings,
  hqSettingsShortcut,
  type HqSettingsProps
} from "./HqSettings.js";

const status = {
  ok: true,
  generatedAt: "2026-10-19T10:00:00Z",
  codex: { configured: false, state: "not_configured", message: "Not set up" },
  api: { state: "healthy" }
} as KoedServerStatus;
const localResponse = (): LocalAiClientResponse => ({
  operation: "list",
  readModel: {
    instances: [
      {
        instanceId: "codex.default",
        driverId: "codex",
        displayName: "Codex",
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
            id: "luna",
            displayName: "Luna",
            provider: "openai",
            model: "luna",
            fullId: "openai/luna",
            reasoningEfforts: ["low", "high"]
          }
        ],
        managedConversationStart: { support: "supported", readiness: "ready" },
        localSynthesis: { support: "supported", readiness: "ready" },
        observedAt: "2026-10-19T10:00:00Z",
        expiresAt: "2099-01-01T00:00:00Z",
        stale: false
      }
    ],
    settings: [],
    defaults: Object.fromEntries(
      flows.map(({ key }) => [
        key,
        {
          source: "code",
          available: true,
          assignment: {
            provider: "codex",
            ai_client_instance_id: "codex.default",
            model: "luna",
            reasoning_effort: "low",
            timeout_ms: 120000,
            max_attempts: 2
          },
          reason: null
        }
      ])
    ) as LocalAiClientResponse["readModel"]["defaults"]
  }
});

describe("HQ-owned Settings", () => {
  let root: Root;
  let container: HTMLDivElement;
  let host: HTMLDivElement;
  let invoke: ReturnType<
    typeof vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >
  >;
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    host = container;
    root = createRoot(container);
    invoke = vi.fn(async (command: string) =>
      command === "status" ? status : { ok: true }
    );
    window.koedDesktop = { invoke } as unknown as DesktopApi;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.koedDesktop;
  });
  const render = async (overrides: Partial<HqSettingsProps> = {}) => {
    const props = {
      statusStore: new DesktopStatusStore(),
      theme: "system",
      onThemeChange: vi.fn(),
      version: "0.8.1",
      onClose: vi.fn(),
      ...overrides
    } satisfies HqSettingsProps;
    await act(async () => root.render(<HqSettings {...props} />));
    container = document.querySelector(".hq-settings") as HTMLDivElement;
    return props;
  };
  const click = async (name: string, scope: ParentNode = document) => {
    const button = [...scope.querySelectorAll("button")].find(
      (item) =>
        item.textContent?.trim() === name ||
        item.getAttribute("aria-label") === name
    );
    expect(button, name).toBeTruthy();
    await act(async () => button!.click());
  };
  it("changes theme and invokes trusted startup and acceleration APIs", async () => {
    const launchAtStartup = {
      get: vi.fn(async () => ({
        enabled: false,
        status: "disabled",
        supported: true
      })),
      set: vi.fn(async () => ({
        enabled: true,
        status: "requires-approval",
        supported: true
      }))
    } as unknown as NonNullable<DesktopApi["launchAtStartup"]>;
    const hardwareAcceleration = {
      get: vi.fn(async () => ({ enabled: false, managedByEnvironment: false })),
      set: vi.fn(async () => ({ enabled: true, managedByEnvironment: false }))
    };
    const props = await render({ launchAtStartup, hardwareAcceleration });
    await act(async () =>
      (
        container.querySelector(
          '.hq-settings__themes button[aria-pressed="false"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(props.onThemeChange).toHaveBeenCalledWith("light");
    await act(async () =>
      (
        container.querySelector(
          '[aria-label="Launch Koed at startup"]'
        ) as HTMLInputElement
      ).click()
    );
    expect(launchAtStartup.set).toHaveBeenCalledWith(true);
    expect(container.textContent).toContain("Allow Koed in System Settings");
    await act(async () =>
      (
        container.querySelector(
          '[aria-label="Hardware acceleration"]'
        ) as HTMLInputElement
      ).click()
    );
    expect(hardwareAcceleration.set).toHaveBeenCalledWith(true);
  });
  it("owns section navigation and closes its modal from close and Escape", async () => {
    const props = await render();
    expect(container.querySelector("main")).toBeNull();
    expect(
      container.matches('[role="dialog"][aria-modal="true"]')
    ).toBeTruthy();
    expect(
      [...container.querySelectorAll("nav button")].map(
        (button) => button.textContent
      )
    ).toEqual(["General", "Agents", "Teams", "Services", "Deleted", "About"]);
    await click("About");
    expect(container.textContent).toContain("Version 0.8.1");
    await click("Close Settings");
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    );
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
  it("keeps nested consent topmost and restores outside focus and background access after parent unmount", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open Settings";
    document.body.append(opener);
    opener.focus();
    await render({ initialSection: "agents" });
    expect(opener.getAttribute("aria-hidden")).toBe("true");
    await click("Set up Codex");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector(".hq-settings")).toBeTruthy();
    await click("Set up Codex");
    await act(async () => root.render(<></>));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(opener.hasAttribute("aria-hidden")).toBe(false);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  it("hides Teams and normalizes a stale Team route when collaboration is disabled", async () => {
    await render({ initialSection: "teams", teamCollaborationEnabled: false });
    expect(container.querySelector("h2")?.textContent).toBe("General");
    expect(container.querySelector("nav")?.textContent).not.toContain("Teams");
  });
  it("requires explicit scoped portal consent before integration setup and retains failed verification", async () => {
    const props = await render({ initialSection: "agents" });
    await click("Set up Codex");
    expect(invoke).not.toHaveBeenCalledWith("setup_codex", expect.anything());
    const popup = document.querySelector(".hq-settings-dialog")!;
    expect(popup.closest("[data-hq-shell]")).toBeTruthy();
    expect(popup.classList.contains("hq-settings-dialog")).toBe(true);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    );
    expect(props.onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".hq-settings-dialog")).toBeNull();
    await click("Set up Codex");
    await click("Set up Codex", document.querySelector(".hq-settings-dialog")!);
    expect(invoke).toHaveBeenCalledWith("setup_codex", {
      operatorConsented: true
    });
    invoke.mockImplementation(async (command: string) =>
      command === "status"
        ? status
        : { capabilityRefresh: { refreshed: false }, message: "Offline" }
    );
    await click("Check Codex");
    expect(container.textContent).toContain("Verification failed");
    await click("Show Codex status details");
    expect(
      document.querySelector(".hq-settings-dialog")?.textContent
    ).toContain("Showing last known results");
  });
  it("shows failed initial refresh truthfully, recovers, and marks retained results as last known", async () => {
    invoke.mockRejectedValueOnce(new Error("Status offline"));
    const props = await render({ initialSection: "agents" });
    expect(container.textContent).toContain("Status offline");
    expect(container.textContent).toContain("AI Client status unavailable");
    expect(container.textContent).not.toContain("Not set up");
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        /^(Set up|Repair|Remove) (Codex|Claude Code|Pi)$/.test(
          button.textContent?.trim() ?? ""
        )
      )
    ).toBe(false);
    await click("Retry status");
    expect(container.textContent).not.toContain("Status offline");
    expect(container.textContent).toContain("Not set up");
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Set up Codex"
      )?.disabled
    ).toBe(false);
    invoke.mockRejectedValueOnce(new Error("Refresh offline"));
    await act(async () => {
      await props.statusStore.refresh();
    });
    expect(container.textContent).toContain(
      "Showing last known AI Client results"
    );
    expect(container.textContent).toContain("Last known: Not set up");
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Set up Codex"
      )?.disabled
    ).toBe(true);
    await click("Show Codex status details");
    expect(
      document.querySelector(".hq-settings-dialog")?.textContent
    ).toContain("Showing last known results");
    await click("Close", document.querySelector(".hq-settings-dialog")!);
    await click("Retry status");
    expect(container.textContent).not.toContain("Last known:");
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Set up Codex"
      )?.disabled
    ).toBe(false);
  });
  it("shows loading rather than inferring an unconfigured integration while status is pending", async () => {
    let resolveStatus!: (value: KoedServerStatus) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<KoedServerStatus>((resolve) => {
          resolveStatus = resolve;
        })
    );
    await render({ initialSection: "agents" });
    expect(container.textContent).toContain("Loading AI Client status");
    expect(container.textContent).not.toContain("Not set up");
    expect(container.textContent).not.toContain("Set up Codex");
    await act(async () => resolveStatus(status));
    expect(container.textContent).toContain("Not set up");
  });
  it("preserves functional model assignment controls and saves through local AI Client API", async () => {
    const response = localResponse();
    const localAiClients = {
      list: vi.fn(async () => response),
      refresh: vi.fn(async () => response),
      set: vi.fn(async () => response),
      reset: vi.fn(async () => response)
    };
    await render({ initialSection: "agents", localAiClients });
    const fieldset = [...container.querySelectorAll("fieldset")].find(
      (item) => item.querySelector("legend")?.textContent === "Conversations"
    )!;
    expect(fieldset).toBeTruthy();
    const effort = fieldset.querySelector(
      '[aria-label="Conversations reasoning effort"]'
    ) as HTMLSelectElement;
    expect(effort).toBeTruthy();
    await act(async () => {
      effort.value = "high";
      effort.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Save", fieldset);
    expect(localAiClients.set).toHaveBeenCalledWith(
      "conversations",
      expect.objectContaining({ reasoning_effort: "high" })
    );
  });
  it("connects, reconnects, and confirms removal through the existing Team client", async () => {
    const client = {
      currentRemoteUrl: () => "https://team.example.com",
      connectRemote: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined)
    };
    await render({
      initialSection: "teams",
      collaborationClient: client as unknown as CollaborationRendererClient,
      collaborationSnapshot: {
        connection: { state: "unavailable", backendId: "backend-a" }
      } as CollaborationSnapshot
    });
    const form = container.querySelector("form")!;
    await act(async () =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      )
    );
    expect(client.connectRemote).toHaveBeenCalledWith({
      remoteUrl: "https://team.example.com"
    });
    await click("Reconnect");
    expect(client.reconnect).toHaveBeenCalledOnce();
    await click("Remove connection");
    expect(client.disconnect).not.toHaveBeenCalled();
    await click(
      "Remove connection",
      document.querySelector(".hq-settings-dialog")!
    );
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
  it("shows read-only service health and refreshes automatically", async () => {
    await render({ initialSection: "services" });
    expect(container.textContent).not.toContain("Run diagnostics");
    expect(container.textContent).not.toContain("Open logs");
    expect(container.textContent).not.toContain("Refresh status");
    expect(container.textContent).toContain("Healthy");
    expect(invoke).toHaveBeenCalledWith("status", undefined);
    expect(invoke).not.toHaveBeenCalledWith("doctor", undefined);
    expect(invoke).not.toHaveBeenCalledWith("open_logs", undefined);
  });
  it("recognizes the existing macOS and other-platform shortcut without extra modifiers", () => {
    const event = {
      key: ",",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false
    };
    expect(hqSettingsShortcut(event)).toBe(true);
    expect(
      hqSettingsShortcut({ ...event, metaKey: false, ctrlKey: true })
    ).toBe(true);
    expect(hqSettingsShortcut({ ...event, altKey: true })).toBe(false);
  });
});
