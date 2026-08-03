// @vitest-environment happy-dom

import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
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

  it("does not invent Capture controls when commands are unavailable", async () => {
    await renderPreferences();
    await clickButton(container, "Capture");

    expect(container.textContent).toContain("Capture controls are unavailable");
    expect(container.querySelector('[aria-label="Capture State"]')).toBeNull();
    expect(container.textContent).toContain("No setting has been inferred");
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
});
