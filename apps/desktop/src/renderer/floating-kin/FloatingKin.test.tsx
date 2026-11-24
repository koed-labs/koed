// @vitest-environment happy-dom
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FloatingKinSummary } from "@koed-labs/shared";
import type { KinPresentation } from "../../ipc/floating-kin-protocol.js";
import * as pixelkin from "../v1/pixelkin/Pixelkin.js";
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
    preview: vi.fn<FloatingKinBridge["preview"]>(async () => null),
    latest: vi.fn(
      async (): Promise<{ action: "conversation" | "project" | null }> => ({
        action: null
      })
    ),
    reopen: vi.fn(async () => ({
      action: "project" as const,
      result: answered
    })),
    openAiModels: vi.fn(),
    openConversation: vi.fn(),
    cancel: vi.fn(async () => undefined),
    completeExit: vi.fn(),
    openDesktop: vi.fn(),
    setInteractive: vi.fn(),
    setSize: vi.fn(),
    drag: vi.fn(),
    onMainWindowFocus: vi.fn(() => () => {})
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

it("drops captured chips and summary state even when a handoff reverses in one render", async () => {
  let publish: (state: KinPresentation) => void = () => {};
  bridge.onPresentation = (listener) => {
    publish = listener;
    return () => {};
  };
  await render();
  await act(async () => publish({ placement: "desktop", revision: 1 }));
  await click("Conversation 1");
  expect(mount.querySelector(".fk-panel")).not.toBeNull();
  const fresh = deferred<Awaited<ReturnType<FloatingKinBridge["activity"]>>>();
  vi.mocked(bridge.activity).mockReturnValueOnce(fresh.promise);
  await act(async () => {
    publish({ placement: "sidebar", revision: 2 });
    publish({ placement: "desktop", revision: 3 });
  });
  expect(mount.querySelector(".fk-panel, .fk-chip")).toBeNull();
  expect(bridge.activity).toHaveBeenLastCalledWith(3);
  await act(async () => fresh.resolve({ state: "stopped" }));
});

it("completes a pending Home handoff only after the native renderer finishes sliding", async () => {
  let publish: (state: KinPresentation) => void = () => {};
  bridge.onPresentation = (listener) => {
    publish = listener;
    return () => {};
  };
  await render();
  await act(async () => publish({ placement: "desktop", revision: 1 }));
  const finished = deferred<void>();
  const surface = mount.querySelector("main")!;
  Object.defineProperty(surface, "getAnimations", {
    value: () => [{ transitionProperty: "opacity", finished: finished.promise }]
  });
  await act(async () =>
    publish({ placement: "sidebar", revision: 2, sidebarPending: true })
  );
  expect(surface.inert).toBe(true);
  expect(mount.querySelector(".fk-chip")).toBeNull();
  expect(bridge.completeExit).not.toHaveBeenCalled();
  await act(async () => finished.resolve());
  expect(bridge.completeExit).toHaveBeenCalledExactlyOnceWith(2);
});

const mouseOver = (target: Element, from?: Element) =>
  act(async () => {
    from?.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: target })
    );
    target.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: from })
    );
  });
const pointer = (
  target: Element,
  type: string,
  x: number,
  y = 100,
  buttons = 1
) =>
  act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        buttons,
        isPrimary: true,
        clientX: x - 80,
        clientY: y - 80,
        screenX: x,
        screenY: y
      })
    );
  });
const capturedClick = (target: Element) =>
  act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });

async function renderQuiet() {
  bridge.activity = vi.fn(async () => ({
    state: "running" as const,
    conversations: [],
    overflowCount: 0
  }));
  await render();
  return mount.querySelector<HTMLElement>(".fk-kin-avatar")!;
}

function expectKinAwake(kin: HTMLElement, awake: boolean) {
  expect(kin.querySelector(".fk-sleep-mark") !== null).toBe(!awake);
  expect(
    kin.querySelector(".v1-pixelkin")?.getAttribute("data-expression")
  ).toBe(awake ? "happy" : "sleepy");
}

describe("Floating Kin", () => {
  it("expires Pi Working while the next activity poll is stalled, without closing its capture preview", async () => {
    const piConversation = {
      ...conversation,
      client: "pi" as const,
      workingUntil: "2026-11-18T12:00:17.000Z"
    };
    const pending =
      deferred<Awaited<ReturnType<FloatingKinBridge["activity"]>>>();
    const activity = vi.mocked(bridge.activity);
    activity
      .mockResolvedValueOnce({
        state: "running",
        conversations: [piConversation],
        overflowCount: 0
      })
      .mockReturnValueOnce(pending.promise);
    await render();

    const chip = mount.querySelector(".fk-chip")!;
    expect(chip.textContent).toContain("Working");
    expect(chip.getAttribute("aria-label")).toContain("Working");
    await click("Pi Conversation 1");
    const panel = mount.querySelector('[role="dialog"]')!;
    expect(panel.textContent).toContain("Captured 12s ago");
    expect(bridge.preview).toHaveBeenCalledExactlyOnceWith({ sessionId });

    await act(async () => vi.advanceTimersByTimeAsync(2_999));
    expect(activity).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(activity).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(chip.textContent).toContain("Working");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(chip.textContent).not.toContain("Working");
    expect(chip.getAttribute("aria-label")).toBe(
      "Pi Conversation 1. Captured 12s ago."
    );
    expect(mount.querySelector('[role="dialog"]')).toBe(panel);
    expect(bridge.preview).toHaveBeenCalledTimes(1);
    expect(activity).toHaveBeenCalledTimes(2);
  });

  it("recognizes a fresh Pi lease after the clock moves backward", async () => {
    const piConversation = { ...conversation, client: "pi" as const };
    vi.mocked(bridge.activity).mockResolvedValue({
      state: "running",
      conversations: [
        { ...piConversation, workingUntil: "2026-11-18T12:00:12.500Z" }
      ],
      overflowCount: 0
    });
    await render();
    const chip = mount.querySelector(".fk-chip")!;
    expect(chip.textContent).toContain("Working");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(chip.textContent).not.toContain("Working");

    vi.setSystemTime(new Date("2026-11-18T12:00:10.000Z"));
    vi.mocked(bridge.activity).mockResolvedValue({
      state: "running",
      conversations: [
        { ...piConversation, workingUntil: "2026-11-18T12:00:13.000Z" }
      ],
      overflowCount: 0
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(chip.textContent).toContain("Working");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(chip.textContent).not.toContain("Working");
  });

  it.each([
    ["Codex", "codex", "2026-11-18T12:00:17.000Z"],
    ["Claude Code", "claude-code", "2026-11-18T12:00:17.000Z"],
    ["Pi", "pi", "2026-11-18T12:00:12.000Z"],
    ["Pi", "pi", undefined]
  ] as const)(
    "keeps %s capture-only without a fresh Pi lease (%s, %s)",
    async (name, client, workingUntil) => {
      const row = {
        ...conversation,
        client,
        ...(workingUntil ? { workingUntil } : {})
      };
      vi.mocked(bridge.activity).mockResolvedValue({
        state: "running",
        conversations: [row],
        overflowCount: 0
      });
      await render();

      const chip = mount.querySelector(".fk-chip")!;
      expect(chip.textContent).toBe("12s");
      expect(chip.getAttribute("aria-label")).toBe(
        `${name} Conversation 1. Captured 12s ago.`
      );
    }
  );

  it("shows captured context only on chip selection without running a summary", async () => {
    vi.mocked(bridge.preview).mockResolvedValue({
      title: "Check release readiness",
      projectName: "Release tooling",
      request: { text: "Which checks are outstanding?", occurredAt: asOf },
      reply: {
        text: "The typecheck passed.",
        occurredAt: "2026-11-18T11:59:58Z"
      }
    });
    await render();
    expect(bridge.preview).not.toHaveBeenCalled();
    await click("Conversation 1");
    expect(bridge.preview).toHaveBeenCalledExactlyOnceWith({ sessionId });
    const panel = mount.querySelector('[role="dialog"]')!;
    for (const text of [
      "Check release readiness",
      "Release tooling",
      "Captured 12s ago",
      "Which checks are outstanding?",
      "Previous captured reply",
      "The typecheck passed."
    ]) {
      expect(panel.textContent).toContain(text);
    }
    expect(bridge.summarize).not.toHaveBeenCalled();
  });

  it("drops pending context on close and refreshes only for a new capture", async () => {
    const previous =
      deferred<Awaited<ReturnType<FloatingKinBridge["preview"]>>>();
    vi.mocked(bridge.preview).mockReturnValueOnce(previous.promise);
    await render();
    await click("Conversation 1");
    await click("Close summary");
    await click("Conversation 1");
    await act(async () =>
      previous.resolve({
        title: "Stale title",
        projectName: null,
        request: null,
        reply: null
      })
    );
    expect(mount.textContent).not.toContain("Stale title");
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(bridge.preview).toHaveBeenCalledTimes(2);
    vi.mocked(bridge.activity).mockResolvedValueOnce({
      state: "running",
      conversations: [
        { ...conversation, lastActivityAt: "2026-11-18T12:00:10Z" }
      ],
      overflowCount: 0
    });
    vi.mocked(bridge.preview).mockResolvedValueOnce({
      title: "New capture",
      projectName: null,
      request: null,
      reply: null
    });
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(mount.textContent).toContain("New capture");
    expect(bridge.preview).toHaveBeenCalledTimes(3);
    expect(bridge.summarize).not.toHaveBeenCalled();
  });

  it("reopens the last summary above the generate actions and links to AI models", async () => {
    bridge.onPresentation = (listener) => {
      listener({ placement: "desktop", revision: 7 });
      return () => {};
    };
    vi.mocked(bridge.latest).mockResolvedValue({ action: "project" });
    await render();
    await click("Conversation 1");
    const panel = mount.querySelector('[role="dialog"]')!;
    expect(panel.textContent).not.toContain("Uses your assigned AI Client");
    expect(
      [...panel.querySelectorAll("button")].map((button) => button.textContent)
    ).toEqual([
      "Recent Conversation",
      "×",
      "Open last summary",
      "Summarize Conversation",
      ""
    ]);
    await click("Recent Conversation");
    expect(bridge.openConversation).toHaveBeenCalledExactlyOnceWith(
      7,
      sessionId
    );
    await click("Open last summary");
    // The summary title isn't the Conversation's, so it isn't a link.
    expect(panel.querySelector(".fk-title-link")).toBeNull();
    expect(panel.textContent).toContain("Project summary");
    expect(panel.textContent).toContain(answered.captured);
    expect(bridge.reopen).toHaveBeenCalledExactlyOnceWith(
      { sessionId, projectId: "koed" },
      7
    );
    expect(bridge.summarize).not.toHaveBeenCalled();
    await click("AI models settings");
    expect(bridge.openAiModels).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("keeps captured context available when opening the last summary fails", async () => {
    vi.mocked(bridge.preview).mockResolvedValue({
      title: "Release checks",
      projectName: null,
      request: { text: "Run the preflight", occurredAt: asOf },
      reply: null
    });
    vi.mocked(bridge.latest).mockResolvedValue({ action: "conversation" });
    vi.mocked(bridge.reopen).mockResolvedValue(null);
    await render();
    await click("Conversation 1");
    await click("Open last summary");
    const content = mount.querySelector('[role="dialog"]')?.textContent;
    expect(content).toContain("Last summary is no longer available.");
    expect(content).toContain("Release checks");
    expect(content).toContain("Run the preflight");
  });

  it("opens Desktop only for an avatar click on the visible revision", async () => {
    let publish: (state: KinPresentation) => void = () => {};
    bridge.onPresentation = (listener) => {
      publish = listener;
      return () => {};
    };
    await render();
    await act(async () => publish({ placement: "desktop", revision: 7 }));
    const avatar = mount.querySelector(
      'button[aria-label="Open Koed Desktop"]'
    )!;
    const hit = vi.spyOn(document, "elementFromPoint").mockReturnValue(avatar);
    await pointer(avatar, "pointerdown", 100);
    await pointer(avatar, "pointerup", 100);
    await capturedClick(avatar);
    expect(bridge.openDesktop).toHaveBeenCalledExactlyOnceWith(7);

    await pointer(avatar, "pointerdown", 100);
    await pointer(avatar, "pointermove", 110);
    await pointer(avatar, "pointerup", 110);
    await capturedClick(avatar);
    hit.mockReturnValue(mount.querySelector("main"));
    await pointer(avatar, "pointerdown", 100);
    await pointer(avatar, "pointerup", 103);
    await capturedClick(avatar);
    await click("Conversation 1");
    expect(mount.querySelector('[role="dialog"]')).not.toBeNull();
    expect(bridge.openDesktop).toHaveBeenCalledTimes(1);
    await click("Open Koed Desktop");
    expect(bridge.openDesktop).toHaveBeenCalledTimes(2);
    await act(async () => publish({ placement: "sidebar", revision: 8 }));
    expect(
      mount.querySelector('button[aria-label="Open Koed Desktop"]')
    ).toBeNull();
  });

  it("enables the engine's arms on the standalone Kin, not the Project Kin chip", async () => {
    const renderPixelkin = vi.spyOn(pixelkin, "Pixelkin");
    await render();
    const lookAtSize = (size: number) =>
      renderPixelkin.mock.calls.find(([props]) => props.size === size)?.[0]
        .look;
    expect(lookAtSize(88)?.body.arms).toBe(true);
    expect(lookAtSize(32)?.body.arms).toBe(false);
  });

  it("keeps the large draggable Kin below the chips when a summary opens", async () => {
    await render();
    const chip = mount.querySelector(".fk-chip")!;
    const avatar = mount.querySelector('[aria-label="Floating Kin avatar"]')!;
    expect(avatar).not.toBeNull();
    expect(avatar.closest(".fk-chip")).toBeNull();
    expect(
      chip.compareDocumentPosition(avatar) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(avatar.querySelector("img")).toBeNull();
    const floatingPixelkin = avatar.querySelector<HTMLElement>(".v1-pixelkin")!;
    expect(floatingPixelkin.style.width).toBe("88px");
    expect(floatingPixelkin.dataset.kinShape).toBe("roundedBox");
    expect(floatingPixelkin.dataset.kinColour).toBe("#3083ff");
    expect(
      floatingPixelkin.style.getPropertyValue("--v1-kin-gradient-top")
    ).toBe("#e8d31a");
    const projectPixelkin = chip.querySelector<HTMLElement>(".v1-pixelkin")!;
    expect(projectPixelkin.style.width).toBe("32px");
    expect(
      projectPixelkin.style.getPropertyValue("--v1-kin-gradient-top")
    ).toBe("");

    await click("Captured 12s ago");
    expect(mount.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mount.querySelector('[aria-label="Floating Kin avatar"]')).toBe(
      avatar
    );
    await mouseOver(avatar);
    expect(mount.querySelector('[role="tooltip"]')).toBeNull();
    await pointer(avatar, "pointerdown", 100);
    await pointer(avatar, "pointermove", 120);
    await pointer(avatar, "pointerup", 120);
    expect(
      vi.mocked(bridge.drag).mock.calls.map(([input]) => input.phase)
    ).toEqual(["start", "move", "end"]);
  });

  it("switches interaction only across chips, summary panel, and click-through regions", async () => {
    bridge.activity = vi.fn(async () => ({
      state: "running" as const,
      conversations: [conversation],
      overflowCount: 1
    }));
    await render();
    await click("Captured 12s ago");
    const chip = mount.querySelector(".fk-chip")!;
    const gap = mount.querySelector("main")!;
    const panelControl = mount.querySelector('[aria-label="Close summary"]')!;
    const overflow = mount.querySelector(".fk-overflow")!;
    await mouseOver(chip);
    await mouseOver(panelControl, chip);
    expect(vi.mocked(bridge.setInteractive).mock.calls).toEqual([[true]]);
    await mouseOver(gap, panelControl);
    await mouseOver(overflow, gap);
    expect(vi.mocked(bridge.setInteractive).mock.calls).toEqual([
      [true],
      [false]
    ]);
    await mouseOver(panelControl, overflow);
    expect(bridge.setInteractive).toHaveBeenLastCalledWith(true);
    await pointer(panelControl, "pointerdown", 100);
    await pointer(panelControl, "pointermove", 120);
    await pointer(panelControl, "pointerup", 120);
    expect(bridge.drag).not.toHaveBeenCalled();
  });

  it("drags the sleeping Kin using absolute coordinates and stays interactive across gaps", async () => {
    const kin = await renderQuiet();
    const capture = vi.spyOn(kin, "setPointerCapture");
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      mount.querySelector("main")
    );
    await mouseOver(kin);
    await pointer(kin, "pointerdown", 100);
    expect(capture).toHaveBeenCalledWith(1);
    expect(document.activeElement).not.toBe(kin);
    await pointer(kin, "pointermove", 103);
    expect(bridge.drag).not.toHaveBeenCalled();
    await pointer(kin, "pointermove", 104);
    expect(kin.getAttribute("aria-describedby")).toBeNull();
    await mouseOver(mount.querySelector("main")!, kin);
    expect(bridge.setInteractive).toHaveBeenLastCalledWith(true);
    await pointer(kin, "pointermove", 139, 95);
    await pointer(kin, "pointerup", 139, 95);
    expect(vi.mocked(bridge.drag).mock.calls).toEqual([
      [{ phase: "start", x: 100, y: 100 }],
      [{ phase: "move", x: 104, y: 100 }],
      [{ phase: "move", x: 139, y: 95 }],
      [{ phase: "end" }]
    ]);
    expect(document.elementFromPoint).toHaveBeenLastCalledWith(59, 15);
    expect(bridge.setInteractive).toHaveBeenLastCalledWith(false);
  });

  it("keeps ordinary chip clicks and suppresses the click following an avatar drag", async () => {
    await render();
    const chip = mount.querySelector(".fk-chip")!;
    const avatar = chip.querySelector(".fk-avatar")!;
    await pointer(chip, "pointerdown", 100);
    await pointer(chip, "pointermove", 120);
    await pointer(chip, "pointerup", 120);
    expect(bridge.drag).not.toHaveBeenCalled();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(avatar);
    await pointer(avatar, "pointerdown", 100);
    await pointer(avatar, "pointermove", 103);
    await pointer(avatar, "pointerup", 103);
    await capturedClick(avatar);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    await click("Close summary");
    await pointer(avatar, "pointerdown", 100);
    await pointer(avatar, "pointermove", 110);
    await pointer(avatar, "pointerup", 110);
    expect(bridge.drag).toHaveBeenLastCalledWith({ phase: "end" });
    await capturedClick(avatar);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    await click("Captured 12s ago");
    expect(chip.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not activate a chip when the captured pointer releases just outside it", async () => {
    await render();
    const chip = mount.querySelector(".fk-chip")!;
    const avatar = chip.querySelector(".fk-avatar")!;
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      mount.querySelector("main")
    );
    await pointer(avatar, "pointerdown", 100);
    await pointer(avatar, "pointerup", 103);
    await capturedClick(avatar);
    expect(bridge.drag).not.toHaveBeenCalled();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });

  it("ends a drag if the mouse moves again after a missed button release", async () => {
    const kin = await renderQuiet();
    vi.spyOn(document, "elementFromPoint").mockReturnValue(null);
    await pointer(kin, "pointerdown", 100);
    await pointer(kin, "pointermove", 110);
    await pointer(kin, "pointermove", 120, 100, 0);
    await pointer(kin, "pointermove", 130, 100, 0);
    expect(vi.mocked(bridge.drag).mock.calls).toEqual([
      [{ phase: "start", x: 100, y: 100 }],
      [{ phase: "move", x: 110, y: 100 }],
      [{ phase: "end" }]
    ]);
    expect(bridge.setInteractive).toHaveBeenLastCalledWith(false);
  });

  it("keeps the overlay interactive when capture is lost over a hit target", async () => {
    const kin = await renderQuiet();
    const hit = vi.spyOn(document, "elementFromPoint").mockReturnValue(kin);
    await pointer(kin, "pointerdown", 100);
    await pointer(kin, "pointermove", 110, 108);
    await pointer(kin, "lostpointercapture", 0, 0);
    expect(bridge.drag).toHaveBeenLastCalledWith({ phase: "end" });
    expect(hit).toHaveBeenLastCalledWith(30, 28);
    expect(bridge.setInteractive).toHaveBeenLastCalledWith(true);
  });

  it.each(["pointercancel", "lostpointercapture"])(
    "ends a drag once on %s",
    async (event) => {
      const kin = await renderQuiet();
      await pointer(kin, "pointerdown", 100);
      await pointer(kin, "pointermove", 110);
      await pointer(kin, event, 110);
      await pointer(kin, "lostpointercapture", 110);
      await pointer(kin, "pointermove", 130);
      expect(vi.mocked(bridge.drag).mock.calls).toEqual([
        [{ phase: "start", x: 100, y: 100 }],
        [{ phase: "move", x: 110, y: 100 }],
        [{ phase: "end" }]
      ]);
      expect(bridge.setInteractive).toHaveBeenLastCalledWith(false);
    }
  );
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
    await click("Summarize Conversation");
    expect(bridge.summarize).toHaveBeenCalledWith({
      sessionId,
      action: "conversation"
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

  it.each([
    ["another Project", "other"],
    ["no Project", null]
  ])(
    "invalidates only Project summaries on change to %s",
    async (_, nextProjectId) => {
      let projectId: string | null = conversation.projectId;
      vi.mocked(bridge.latest).mockResolvedValue({ action: "project" });
      bridge.activity = vi.fn(async () => ({
        state: "running" as const,
        conversations: [{ ...conversation, projectId }],
        overflowCount: 0
      }));
      const titles: (string | null | undefined)[] = [];
      await act(async () =>
        root.render(
          <Profiler
            id="kin"
            onRender={() => titles.push(mount.querySelector("h2")?.textContent)}
          >
            <FloatingKin bridge={bridge} />
          </Profiler>
        )
      );
      await click("Captured 12s ago");
      const body = mount.querySelector<HTMLElement>(".fk-body")!;
      const updateProject = async (next: string | null) => {
        titles.length = 0;
        projectId = next;
        await act(async () => vi.advanceTimersByTimeAsync(3_000));
        expect(titles.length).toBeGreaterThan(0);
        expect(titles).not.toContain("Project summary");
        expect(document.activeElement).toBe(body);
      };

      await click("Open last summary");
      expect(mount.textContent).toContain("Read local tests.");
      body.focus();
      await updateProject(nextProjectId);
      expect(mount.textContent).not.toContain("Read local tests.");
      expect(bridge.cancel).not.toHaveBeenCalled();
      await updateProject(conversation.projectId);
      expect(mount.textContent).not.toContain("Read local tests.");

      const pending = deferred<{
        action: "project";
        result: typeof answered;
      }>();
      vi.mocked(bridge.reopen).mockReturnValueOnce(pending.promise);
      await click("Open last summary");
      expect(mount.textContent).toContain("Opening last summary");
      body.focus();
      await updateProject(nextProjectId);
      expect(mount.textContent).not.toContain("Opening last summary");
      expect(bridge.cancel).toHaveBeenCalledOnce();
      await updateProject(conversation.projectId);
      await act(async () =>
        pending.resolve({ action: "project", result: answered })
      );
      expect(mount.textContent).not.toContain("Read local tests.");
      expect(mount.textContent).toContain("Recent Conversation");

      const pendingConversation = deferred<FloatingKinSummary>();
      vi.mocked(bridge.summarize).mockReturnValueOnce(
        pendingConversation.promise
      );
      await click("Summarize Conversation");
      body.focus();
      await updateProject(nextProjectId);
      expect(mount.textContent).toContain("Conversation summary");
      expect(mount.textContent).toContain("Summarizing captured work");
      await act(async () => pendingConversation.resolve(answered));
      await updateProject(conversation.projectId);
      expect(mount.textContent).toContain("Conversation summary");
      expect(mount.textContent).toContain("Read local tests.");
      expect(bridge.cancel).toHaveBeenCalledOnce();
    }
  );

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

  it("restores chip focus on Escape and offers Conversation summary without a Project", async () => {
    bridge.activity = vi.fn(async () => ({
      state: "running" as const,
      conversations: [{ ...conversation, projectId: null }],
      overflowCount: 0
    }));
    await render();
    await click("Captured 12s ago");
    expect(
      mount.querySelector<HTMLButtonElement>(".fk-actions button")?.disabled
    ).toBe(false);
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

  it("wakes for one minute on appearing, then sleeps", async () => {
    const kin = await renderQuiet();
    expectKinAwake(kin, true);
    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expectKinAwake(kin, true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expectKinAwake(kin, false);
  });

  it("reappears without a runtime status while its fresh read is pending", async () => {
    let present: (presentation: {
      placement: "desktop" | "sidebar";
      revision: number;
    }) => void = () => {};
    bridge.onPresentation = (listener) => {
      present = listener;
      listener({ placement: "desktop", revision: 1 });
      return () => {};
    };
    await render();
    await act(async () => present({ placement: "sidebar", revision: 2 }));
    const next = deferred<Awaited<ReturnType<FloatingKinBridge["activity"]>>>();
    bridge.activity = vi.fn(() => next.promise);
    await act(async () => present({ placement: "desktop", revision: 3 }));
    expect(mount.querySelector('[role="status"]')).toBeNull();
    await act(async () => next.resolve({ state: "starting" }));
    expect(mount.querySelector('[role="status"]')?.textContent).toContain(
      "Local runtime starting"
    );
  });

  it("slides in only after its first activity read sizes the content", async () => {
    let present: (presentation: {
      placement: "desktop" | "sidebar";
      revision: number;
    }) => void = () => {};
    bridge.onPresentation = (listener) => {
      present = listener;
      return () => {};
    };
    const first =
      deferred<Awaited<ReturnType<FloatingKinBridge["activity"]>>>();
    bridge.activity = vi.fn(() => first.promise);
    await render();
    const surface = mount.querySelector<HTMLElement>("main")!;
    await act(async () => present({ placement: "desktop", revision: 1 }));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(surface.dataset.visible).toBe("false");

    await act(async () =>
      first.resolve({
        state: "running",
        conversations: [conversation],
        overflowCount: 0
      })
    );
    expect(mount.querySelector(".fk-chip")).not.toBeNull();
    // Two frames: paint the hidden start, then change from it.
    await act(async () => vi.advanceTimersByTimeAsync(40));
    expect(surface.dataset.visible).toBe("true");

    await act(async () => present({ placement: "sidebar", revision: 2 }));
    expect(surface.dataset.visible).toBe("false");
  });

  it("stays awake while it leaves for the sidebar", async () => {
    let present: (presentation: {
      placement: "desktop" | "sidebar";
      revision: number;
      sidebarPending?: boolean;
    }) => void = () => {};
    bridge.onPresentation = (listener) => {
      present = listener;
      listener({ placement: "desktop", revision: 1 });
      return () => {};
    };
    await renderQuiet();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await act(async () =>
      present({ placement: "sidebar", revision: 2, sidebarPending: true })
    );
    expectKinAwake(mount.querySelector<HTMLElement>(".fk-kin-avatar")!, true);
  });

  it("wakes for one minute after hover without showing a quiet message", async () => {
    const kin = await renderQuiet();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expectKinAwake(kin, false);
    await mouseOver(kin);
    expectKinAwake(kin, true);
    expect(kin.getAttribute("aria-description")).toBe("Awake");
    expect(bridge.setInteractive).toHaveBeenLastCalledWith(true);
    await mouseOver(mount.querySelector("main")!, kin);
    expect(bridge.setInteractive).toHaveBeenLastCalledWith(false);
    await act(async () => kin.focus());
    expect(mount.querySelector('[role="tooltip"]')).toBeNull();
    expect(mount.textContent).not.toContain("No recent capture");
    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expectKinAwake(kin, true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expectKinAwake(kin, false);
    expect(kin.getAttribute("aria-description")).toBe("Sleeping");
  });

  it("matches the sleep mark to capture freshness even with older Conversation chips", async () => {
    await render();
    const kin = mount.querySelector<HTMLElement>(".fk-kin-avatar")!;
    expectKinAwake(kin, true);
    const pending =
      deferred<Awaited<ReturnType<FloatingKinBridge["activity"]>>>();
    vi.mocked(bridge.activity).mockReturnValueOnce(pending.promise);
    await act(async () => vi.advanceTimersByTimeAsync(47_999));
    expectKinAwake(kin, true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mount.querySelector(".fk-chip")).not.toBeNull();
    // Still inside the minute it wakes for on appearing.
    expectKinAwake(kin, true);
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    expect(mount.querySelector(".fk-chip")).not.toBeNull();
    expectKinAwake(kin, false);
  });

  it("stays awake while the main Desktop window is focused, independently of the hover timer", async () => {
    const unsubscribe = vi.fn();
    vi.mocked(bridge.onMainWindowFocus).mockReturnValue(unsubscribe);
    const kin = await renderQuiet();
    const notify = vi.mocked(bridge.onMainWindowFocus).mock.calls[0]![0];
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expectKinAwake(kin, false);
    await act(async () => notify(true));
    expectKinAwake(kin, true);
    await mouseOver(kin);
    await act(async () => vi.advanceTimersByTimeAsync(60_001));
    expectKinAwake(kin, true);
    await act(async () => notify(false));
    expectKinAwake(kin, false);
    await act(async () => root.render(null));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus on the avatar when a Conversation chip arrives", async () => {
    bridge.onPresentation = (listener) => {
      listener({ placement: "desktop", revision: 1 });
      return () => {};
    };
    const sleepingKin = await renderQuiet();
    expect(sleepingKin).toBeInstanceOf(HTMLButtonElement);
    vi.mocked(bridge.activity).mockResolvedValue({
      state: "running",
      conversations: [conversation],
      overflowCount: 0
    });
    await act(async () => sleepingKin.focus());
    expect(document.activeElement).toBe(sleepingKin);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mount.querySelector(".fk-chip")).not.toBeNull();
    expect(document.activeElement).toBe(sleepingKin);
    expect(mount.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("shows only the Kin until the first activity read lands", async () => {
    const activity =
      deferred<Awaited<ReturnType<FloatingKinBridge["activity"]>>>();
    bridge.activity = vi.fn(() => activity.promise);
    await render();

    // A pending read is not a runtime state, so no status pill flashes.
    expect(mount.querySelector('[role="status"]')).toBeNull();
    expect(mount.textContent).not.toContain("Local runtime starting");
    const avatar = mount.querySelector('[aria-label="Floating Kin avatar"]');
    expect(
      avatar?.querySelector<HTMLElement>(".v1-pixelkin")?.style.width
    ).toBe("88px");

    await act(async () =>
      activity.resolve({
        state: "running",
        conversations: [],
        overflowCount: 0
      })
    );
    expect(mount.querySelector('[role="status"]')).toBeNull();
    expect(mount.querySelector('[aria-label="Floating Kin avatar"]')).toBe(
      avatar
    );
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
