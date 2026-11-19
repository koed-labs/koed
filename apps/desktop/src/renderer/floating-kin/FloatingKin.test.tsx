// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FloatingKinSummary } from "@koed-labs/shared";
import { FloatingKin, type FloatingKinBridge } from "./FloatingKin.js";

const sessionId = "00000000-0000-4000-8000-000000000001";
const asOf = "2026-11-18T12:00:00.000Z";
const conversation = {
  sessionId,
  client: "codex",
  lastActivityAt: asOf,
  projectId: "koed"
} as const;
const answered = {
  status: "answered",
  asOf,
  captured: "Read local tests.",
  inferred: "Likely checking timing.",
  truncated: true,
  client: "pi",
  model: "test-model",
  effort: "medium",
  sources: [
    { id: sessionId, sessionId, kind: "conversation_item", occurredAt: asOf }
  ]
} satisfies FloatingKinSummary;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

let root: Root;
let mount: HTMLDivElement;
let bridge: FloatingKinBridge;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T12:00:12.000Z"));
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  bridge = {
    activity: vi.fn(async () => ({
      state: "running" as const,
      conversations: [conversation],
      overflowCount: 0
    })),
    summarize: vi.fn(async () => answered),
    cancel: vi.fn(async () => undefined),
    setInteractive: vi.fn(),
    setSize: vi.fn()
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  mount.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const render = () =>
  act(async () => root.render(<FloatingKin bridge={bridge} />));
const click = (name: string) =>
  act(async () => {
    const button = [...mount.querySelectorAll("button")].find(
      (item) =>
        item.textContent?.includes(name) ||
        item.getAttribute("aria-label")?.includes(name)
    );
    expect(button).toBeDefined();
    button?.click();
  });

describe("Floating Kin", () => {
  it("caps recent capture chips and includes local and remote overflow", async () => {
    bridge.activity = vi.fn(async () => ({
      state: "running" as const,
      overflowCount: 2,
      conversations: Array.from({ length: 4 }, (_, i) => ({
        ...conversation,
        sessionId: `${sessionId.slice(0, -1)}${i}`
      }))
    }));
    await render();
    expect(mount.querySelectorAll("button[aria-expanded]")).toHaveLength(3);
    expect(mount.textContent).toContain("+3");
    expect(mount.textContent).toContain("12s");
    expect(
      mount.querySelector('button[aria-label*="Captured 12s ago"]')
    ).not.toBeNull();
  });

  it("renders captured and inferred fields with Koed time and assigned model", async () => {
    await render();
    await click("Captured 12s ago");
    await click("Summarize Project");
    expect(bridge.summarize).toHaveBeenCalledWith({
      sessionId,
      action: "project",
      projectId: conversation.projectId
    });
    expect(mount.textContent).toContain("CapturedRead local tests.");
    expect(mount.textContent).toContain("InferredLikely checking timing.");
    expect(mount.textContent).toContain("Pi · test-model · medium effort");
    expect(mount.querySelector("footer time")?.getAttribute("datetime")).toBe(
      asOf
    );
    expect(mount.textContent).toContain("Conversation item");
    expect(mount.textContent).toContain("Evidence was truncated");
  });

  it("cancels a pending Conversation summary and ignores its late answer", async () => {
    const summary = deferred<FloatingKinSummary>();
    bridge.summarize = vi.fn(() => summary.promise);
    await render();
    await click("Captured 12s ago");
    await click("Summarize Conversation");
    expect(bridge.summarize).toHaveBeenCalledWith({
      sessionId,
      action: "conversation"
    });
    await click("Cancel");
    expect(bridge.cancel).toHaveBeenCalledOnce();
    await act(async () => summary.resolve(answered));
    expect(mount.textContent).toContain("Summary cancelled");
    expect(mount.textContent).not.toContain("Read local tests.");
  });

  it("blocks a new summary until the cancelled request settles", async () => {
    const summary = deferred<FloatingKinSummary>();
    bridge.summarize = vi.fn(() => summary.promise);
    await render();
    await click("Captured 12s ago");
    await click("Summarize Conversation");
    await click("Cancel");
    expect(mount.textContent).toContain("Cancelling summary");
    expect(
      mount.querySelector<HTMLButtonElement>(".fk-actions button")?.disabled
    ).toBe(true);
    await act(async () => summary.resolve(answered));
    expect(
      mount.querySelector<HTMLButtonElement>(".fk-actions button")?.disabled
    ).toBe(false);
  });

  it("restores chip focus on Escape and disables Project summary without a Project", async () => {
    bridge.activity = vi.fn(async () => ({
      state: "running" as const,
      conversations: [{ ...conversation, projectId: null }],
      overflowCount: 0
    }));
    await render();
    await click("Captured 12s ago");
    expect(
      mount.querySelector<HTMLButtonElement>(".fk-actions button:last-child")
        ?.disabled
    ).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Close summary"
    );
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(mount.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(mount.querySelector(".fk-chip"));
  });

  it("polls serially and does not schedule another read after unmount", async () => {
    const activity =
      deferred<Awaited<ReturnType<FloatingKinBridge["activity"]>>>();
    bridge.activity = vi.fn(() => activity.promise);
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(bridge.activity).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    await act(async () => activity.resolve({ state: "stopped" }));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(bridge.activity).toHaveBeenCalledOnce();
    expect(bridge.setInteractive).toHaveBeenLastCalledWith(false);
  });

  it("shows the quiet message only while hovering or focusing the sleeping Kin", async () => {
    bridge.activity = vi.fn(async () => ({
      state: "running" as const,
      conversations: [],
      overflowCount: 0
    }));
    await render();
    expect(mount.textContent).not.toContain("No recent capture");
    const sleepingKin = mount.querySelector<HTMLElement>(
      '[aria-label="No recent capture"]'
    );
    expect(sleepingKin?.querySelector(".v1-pixelkin")).not.toBeNull();
    if (!sleepingKin) throw new Error("Sleeping Kin is missing");
    const move = (type: string) =>
      act(async () => {
        sleepingKin.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      });
    await move("mouseover");
    await move("mousemove");
    expect(mount.querySelector('[role="tooltip"]')?.textContent).toContain(
      "No recent capture"
    );
    expect(bridge.setInteractive).not.toHaveBeenCalledWith(true);
    await move("mouseout");
    expect(mount.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => sleepingKin.focus());
    expect(mount.querySelector('[role="tooltip"]')?.textContent).toContain(
      "Nothing recent has been captured by Koed."
    );
    await act(async () => sleepingKin.blur());
    expect(mount.querySelector('[role="tooltip"]')).toBeNull();
    expect(bridge.summarize).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: "stopped" }, "Local runtime stopped"],
    [{ state: "starting" }, "Local runtime starting"],
    [{ state: "signed_out" }, "Sign-in needed"],
    [{ state: "unavailable" }, "Local runtime unavailable"]
  ] as const)("shows the current activity state", async (activity, label) => {
    bridge.activity = vi.fn(async () => activity);
    await render();
    expect(mount.textContent).toContain(label);
    expect(mount.querySelector("button")).toBeNull();
    expect(bridge.summarize).not.toHaveBeenCalled();
  });
});
