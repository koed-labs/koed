// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateApi, DesktopUpdateState } from "@koed/shared/desktop-update-contract";
import { DesktopUpdateIndicator, DesktopUpdatePanel } from "./DesktopUpdate.js";
import { useDesktopUpdate } from "./use-desktop-update.js";

const idle: DesktopUpdateState = { installedVersion: "0.8.1", status: "idle", release: null, checkedAt: null };
const available: DesktopUpdateState = { ...idle, status: "available", release: { version: "0.9.0", summary: "<img src=x onerror=alert(1)>\nNew release" } };
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const fixture = (initial = idle) => {
  let listener: ((state: DesktopUpdateState) => void) | undefined;
  const unsubscribe = vi.fn();
  const api: DesktopUpdateApi = {
    getState: vi.fn(async () => initial), checkForUpdates: vi.fn(async () => available),
    openReleasePage: vi.fn(async () => available),
    subscribe: vi.fn((callback) => { listener = callback; return unsubscribe; })
  };
  return { api, unsubscribe, emit: (state: DesktopUpdateState) => listener?.(state) };
};
function Surface({ api }: { api?: DesktopUpdateApi }) {
  const update = useDesktopUpdate(api);
  return <><DesktopUpdateIndicator update={update} onOpen={() => {}} /><DesktopUpdatePanel update={update} /></>;
}
const click = async (label: string) => {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
};

describe("Desktop update notice UI", () => {
  it("shows installed/latest versions and plain-text notes, with no download/install action", async () => {
    const f = fixture(available);
    await act(async () => root.render(<Surface api={f.api} />));
    expect(host.textContent).toContain("0.8.1");
    expect(host.textContent).toContain("0.9.0");
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector('[aria-label="Update available"]')).not.toBeNull();
    await click("View release");
    expect(f.api.openReleasePage).toHaveBeenCalledExactlyOnceWith();
    expect(host.textContent).toContain("CLI");
    expect(host.textContent).toContain("stop --json");
    for (const button of host.querySelectorAll("button")) {
      expect(button.textContent).not.toMatch(/^(Download|Install|Restart)/u);
    }
    await act(async () => root.unmount());
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    root = createRoot(host);
  });

  it("manual check reports current without prompting, unknown build is not up to date", async () => {
    const f = fixture();
    vi.mocked(f.api.checkForUpdates).mockResolvedValue({ ...idle, status: "current" });
    await act(async () => root.render(<Surface api={f.api} />));
    await click("Check for updates");
    expect(host.textContent).toContain("up to date");
    expect(host.querySelector('[aria-label="Update available"]')).toBeNull();
    await act(async () => root.render(<Surface />));
    expect(host.textContent).not.toContain("up to date");
    expect(host.textContent).toContain("unavailable");
  });

  it("ignores stale initial snapshot after newer event and removes subscription", async () => {
    const f = fixture();
    let resolve: ((state: DesktopUpdateState) => void) | undefined;
    vi.mocked(f.api.getState).mockReturnValue(new Promise((done) => { resolve = done; }));
    await act(async () => root.render(<Surface api={f.api} />));
    await act(async () => f.emit(available));
    await act(async () => resolve?.(idle));
    expect(host.textContent).toContain("0.9.0");
    await act(async () => root.render(<Surface />));
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    await act(async () => f.emit(available));
    expect(host.textContent).not.toContain("0.9.0");
  });

  it("sanitizes manual errors and clears busy after completion/unmount", async () => {
    const f = fixture(available);
    vi.mocked(f.api.openReleasePage).mockRejectedValue(new Error("secret/private/path"));
    await act(async () => root.render(<Surface api={f.api} />));
    await click("View release");
    expect(host.textContent).toContain("Could not open official release page");
    expect(host.textContent).not.toContain("secret");
    expect(host.querySelector("button:disabled")).toBeNull();
    vi.mocked(f.api.checkForUpdates).mockRejectedValue(new Error("token leak"));
    await click("Check for updates");
    expect(host.textContent).toContain("Could not check for updates");
    expect(host.textContent).not.toContain("token leak");
  });
});
