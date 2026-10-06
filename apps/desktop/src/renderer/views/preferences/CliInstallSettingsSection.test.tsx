// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliInstallApi } from "../../../cli-install/protocol.js";
import { CliInstallSettingsSection } from "./CliInstallSettingsSection.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});
const render = async (api?: CliInstallApi) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<CliInstallSettingsSection api={api} />));
  return container;
};
const click = async (element: Element) =>
  act(async () => (element as HTMLElement).click());

const makeApi = () =>
  ({
    getStatus: vi.fn(async () => ({
      available: true,
      state: "not_installed" as const,
      message: "Not installed"
    })),
    installPrivacy: vi.fn(async () => ({
      available: true,
      state: "ready" as const,
      message: "Ready"
    })),
    cancel: vi.fn(async () => undefined),
    selectOffline: vi.fn(async () => null),
    launcher: vi.fn(async () => ({
      ownership: "absent" as const,
      target: "missing" as const,
      helper: "unsupported" as const,
      version: null,
      pathVisible: false,
      fingerprint: null
    })),
    updatePath: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined)
  }) satisfies CliInstallApi;

describe("CLI install preferences", () => {
  it("shows actionable unavailable state without simulated success", async () => {
    const view = await render();
    expect(view.textContent).toContain("Desktop installer bridge unavailable");
    expect(view.textContent).toContain("Koed CLI launcher");
    expect(view.querySelector("button")?.textContent).toContain(
      "Choose offline model file"
    );
  });

  it("requires independent Privacy Filter and PATH consent", async () => {
    const api = makeApi();
    const view = await render(api);
    const install = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "Install Privacy Filter"
    )!;
    expect(install.disabled).toBe(true);
    const consents = [...view.querySelectorAll('input[type="checkbox"]')];
    await click(consents[0]!);
    expect(install.disabled).toBe(false);
    await click(install);
    expect(api.installPrivacy).toHaveBeenCalledWith(true, undefined);
    expect(api.updatePath).not.toHaveBeenCalled();
    const addPath = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "Add Koed to PATH"
    )!;
    expect(addPath.disabled).toBe(true);
    await click(consents[1]!);
    expect(addPath.disabled).toBe(false);
    await click(addPath);
    expect(api.updatePath).toHaveBeenCalledWith("add", true);
  });
});
