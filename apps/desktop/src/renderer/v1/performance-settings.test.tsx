// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopPerformanceApi,
  DesktopPerformanceState,
  PerformanceSnapshot
} from "@koed-labs/server";
import { PerformanceSettings } from "./PerformanceSettings.js";
let root: Root;
let mount: HTMLDivElement;
let snapshot: PerformanceSnapshot;
let api: DesktopPerformanceApi;
let result: DesktopPerformanceState;
beforeEach(() => {
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  snapshot = {
    revision: "a".repeat(64),
    runtimeEpoch: "one",
    runtimeState: "running",
    cpuCount: 12,
    preference: { profile: "balanced", overrides: {} },
    effective: {
      backgroundNice: 10,
      embeddingThreads: 6,
      transcriptPollMs: 1000
    },
    profileManaged: false,
    managed: {},
    invalid: {},
    readOnlyReason: null
  };
  result = { snapshot, operation: null };
  api = {
    inspect: vi.fn(async () => result),
    apply: vi.fn(async () => ({
      ...result,
      operation: { id: "op", state: "running" as const, message: "Applying…" }
    }))
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  mount.remove();
  vi.useRealTimers();
});
const render = async () => {
  await act(async () =>
    root.render(<PerformanceSettings api={api} onBack={() => {}} />)
  );
};
const button = (text: string) =>
  [...mount.querySelectorAll("button")].find((e) =>
    e.textContent?.includes(text)
  )!;
const click = async (text: string) => {
  await act(async () => button(text).click());
};
const slider = (label: string) =>
  mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const key = async (label: string, key: string) => {
  await act(async () =>
    slider(label).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true })
    )
  );
};
describe("approved performance interactions", () => {
  it("uses three sliders with keys below, resets all overrides by selecting the current profile, and discards", async () => {
    await render();
    await click("Individual settings");
    expect(mount.querySelectorAll('input[type="range"]')).toHaveLength(3);
    expect(mount.textContent).not.toMatch(
      /Reset|Use profile|Automatic optimisations|nice|Choose a profile to restore/
    );
    await key("Embedding threads", "ArrowRight");
    expect(slider("Embedding threads").value).toBe("7");
    await key("Transcript checks", "ArrowRight");
    expect(slider("Transcript checks").value).toBe("2");
    await key("Background priority", "ArrowRight");
    await click("Apply & restart");
    expect(api.apply).toHaveBeenCalledWith({
      profile: "balanced",
      overrides: {
        embeddingThreads: 7,
        transcriptPollMs: 2000,
        backgroundNice: 9
      },
      expectedRevision: "a".repeat(64)
    });
  });
  it("profile reselection clears custom values and Discard restores the saved custom values", async () => {
    snapshot.preference.overrides = {
      embeddingThreads: 9,
      transcriptPollMs: 7000
    };
    snapshot.effective = {
      ...snapshot.effective,
      embeddingThreads: 9,
      transcriptPollMs: 7000
    };
    await render();
    await click("Individual settings");
    await click("Balanced");
    expect(slider("Embedding threads").value).toBe("6");
    expect(slider("Transcript checks").value).toBe("1");
    await click("Discard");
    expect(slider("Embedding threads").value).toBe("9");
    expect(slider("Transcript checks").value).toBe("7");
    await click("Low");
    expect(slider("Embedding threads").value).toBe("3");
    expect(slider("Transcript checks").value).toBe("15");
  });
  it("locks environment-controlled values and the profile independently", async () => {
    snapshot.profileManaged = true;
    snapshot.managed.embeddingThreads = "Managed by the environment";
    snapshot.effective.embeddingThreads = 4;
    await render();
    await click("Individual settings");
    expect(button("Low").disabled).toBe(true);
    expect(slider("Embedding threads").disabled).toBe(true);
    expect(slider("Transcript checks").disabled).toBe(false);
  });
  it("offers saving on stopped services and locks external runtimes", async () => {
    snapshot.runtimeState = "stopped";
    await render();
    await click("Low");
    expect(button("Save preference").disabled).toBe(false);
    snapshot = {
      ...snapshot,
      readOnlyReason: "Performance is managed by the external runtime."
    };
    result = { snapshot, operation: null };
    await click("Discard");
    expect(button("Low").disabled).toBe(true);
    expect(button("Save preference").disabled).toBe(true);
  });
  it("keeps a draft on a concurrent config edit and requires discard", async () => {
    vi.useFakeTimers();
    await render();
    await click("Low");
    snapshot = { ...snapshot, revision: "b".repeat(64) };
    result = { snapshot, operation: null };
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(mount.textContent).toContain(
      "Settings changed since you started editing"
    );
    expect(button("Apply & restart").disabled).toBe(true);
    await click("Discard");
    expect(button("Balanced").getAttribute("aria-pressed")).toBe("true");
  });
});
