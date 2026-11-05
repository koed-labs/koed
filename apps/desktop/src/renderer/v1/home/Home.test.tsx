// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopStatusStore } from "../../services/desktop-commands.js";
import { DEFAULT_AGENT_LOOK } from "../pixelkin/agent-kin.js";
import { Home, HOME_RERANK_MS } from "./Home.js";
import type { HomeProjectEntry, HomeView } from "./home-model.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const agent = { name: "Koed", look: DEFAULT_AGENT_LOOK };
const projectsView: HomeView = { kind: "projects", warnings: [] };
const entry = (
  id: string,
  latestAt: string,
  eventCount = 10
): HomeProjectEntry => ({ id, name: id, eventCount, latestAt });

describe("Home", () => {
  let container: HTMLDivElement;
  let root: Root;
  let reducedMotion = false;
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-11-03T12:00:00Z") });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    reducedMotion = false;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce") && reducedMotion,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const render = async (
    props: Partial<Parameters<typeof Home>[0]> & { entries: HomeProjectEntry[] }
  ) =>
    act(async () =>
      root.render(
        <Home
          view={projectsView}
          clients={[]}
          agent={agent}
          statusStore={new DesktopStatusStore()}
          onOpenProject={() => undefined}
          {...props}
        />
      )
    );
  const kin = (name: string) =>
    container.querySelector<HTMLButtonElement>(
      `button[aria-label^="Open Project ${name},"]`
    )!;
  const front = (name: string) => kin(name).hasAttribute("data-lead");

  it.each<HomeView>([
    { kind: "loading" },
    { kind: "attention", problems: [], primary: null },
    { kind: "empty", warnings: [] }
  ])("puts the $kind state on the same stage as Projects", async (view) => {
    await render({ view, entries: [] });
    // No clients, no keycap row: the stage closes up rather than keep a gap.
    expect(container.querySelector(".v1-home-keycaps")).toBeNull();
    expect(
      container.querySelector(".v1-home-stage .v1-home-caption")
    ).not.toBeNull();
    // While loading nothing is known about the clients yet.
    if (view.kind === "loading") return;
    await render({
      view,
      entries: [],
      clients: [
        {
          id: "codex",
          name: "Codex",
          state: "connected",
          label: "Connected",
          version: null
        }
      ]
    });
    expect(
      container.querySelector(
        ".v1-home-stage .v1-home-stage-top .v1-home-keycaps"
      )
    ).not.toBeNull();
  });

  it("refreshes status while Home remains open and stops on unmount", async () => {
    const statusStore = new DesktopStatusStore();
    const refresh = vi.spyOn(statusStore, "refresh").mockResolvedValue(null);
    await render({
      entries: [],
      view: { kind: "empty", warnings: [] },
      statusStore
    });
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it("lays conversations in no Project on the floor as coins", async () => {
    const onOpenConversation = vi.fn();
    await render({
      entries: [entry("koed", "2026-11-03T11:59:00Z")],
      looseConversations: [
        {
          key: "older",
          title: "Older loose chat",
          latestAt: "2026-11-01T00:00:00Z",
          client: null
        },
        {
          key: "newer",
          title: "Pi OAuth and Extension Repair",
          latestAt: "2026-11-03T00:00:00Z",
          client: "pi"
        }
      ],
      onOpenConversation
    });
    const coins = [
      ...container.querySelectorAll<HTMLButtonElement>(".v1-home-floor-coin")
    ];
    // Newest first; the tooltip names it, with its client's logo.
    expect(coins.map((coin) => coin.getAttribute("aria-label"))).toEqual([
      "Open Pi OAuth and Extension Repair",
      "Open Older loose chat"
    ]);
    expect(coins[0]!.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Pi OAuth and Extension Repair"
    );
    expect(coins[0]!.querySelector(".v1-home-floor-client")).not.toBeNull();
    expect(coins[1]!.querySelector(".v1-home-floor-client")).toBeNull();
    await act(async () => coins[0]!.click());
    expect(onOpenConversation.mock.calls).toEqual([["newer"]]);
  });

  const pointer = (
    target: Element,
    type: string,
    clientX: number,
    clientY = 0
  ) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId: 1,
        clientX,
        clientY
      })
    );

  it("throws a floor coin without opening its conversation", async () => {
    reducedMotion = true;
    const onOpenConversation = vi.fn();
    await render({
      entries: [entry("koed", "2026-11-03T11:59:00Z")],
      looseConversations: [
        {
          key: "loose",
          title: "Loose chat",
          latestAt: "2026-11-03T00:00:00Z",
          client: null
        }
      ],
      onOpenConversation
    });
    const coin = container.querySelector(".v1-home-floor-coin")!;
    await act(async () => {
      pointer(coin, "pointerdown", 0);
      pointer(coin, "pointermove", 60);
      pointer(coin, "pointermove", 120);
    });
    expect(coin.getAttribute("data-motion")).toBe("held");
    await act(async () => {
      pointer(coin, "pointerup", 120);
      (coin as HTMLElement).click();
    });
    // With reduced motion it drops straight to the floor where it was let go.
    expect(coin.getAttribute("data-motion")).toBe("rest");
    expect((coin as HTMLElement).style.getPropertyValue("--coin-x")).toBe(
      "calc(50% + 120px)"
    );
    expect(onOpenConversation).not.toHaveBeenCalled();
    await act(async () => (coin as HTMLElement).click());
    expect(onOpenConversation.mock.calls).toEqual([["loose"]]);
  });

  it("lets a thrown coin fly, bounce and settle flat", async () => {
    await render({
      entries: [entry("koed", "2026-11-03T11:59:00Z")],
      looseConversations: [
        {
          key: "loose",
          title: "Loose chat",
          latestAt: "2026-11-03T00:00:00Z",
          client: null
        }
      ],
      onOpenConversation: () => undefined
    });
    const coin = container.querySelector<HTMLElement>(".v1-home-floor-coin")!;
    const height = () => parseFloat(coin.style.getPropertyValue("--coin-y"));
    const resting = height();
    await act(async () => {
      pointer(coin, "pointerdown", 0, 0);
      for (let step = 1; step <= 4; step += 1) {
        vi.advanceTimersByTime(16);
        pointer(coin, "pointermove", step * 10, -step * 30);
      }
      pointer(coin, "pointerup", 40, -120);
    });
    const heights: number[] = [];
    const modes = new Set<string>();
    for (let frame = 0; frame < 400; frame += 1) {
      await act(async () => vi.advanceTimersByTime(16));
      heights.push(height());
      modes.add(coin.dataset.motion!);
    }
    expect(modes.has("flying")).toBe(true);
    // It rises with the flick (to the ceiling of this unsized test stage),
    // then falls back to the floor.
    expect(Math.max(...heights)).toBeGreaterThan(resting + 40);
    expect(coin.dataset.motion).toBe("rest");
    expect(height()).toBe(resting);
    // Bounces: it leaves the floor again after first landing.
    const landed = heights.findIndex((value) => value === resting);
    expect(heights.slice(landed).some((value) => value > resting)).toBe(true);
    // Carried right by the throw.
    expect(coin.style.getPropertyValue("--coin-x")).not.toBe("calc(50% + 0px)");
  });

  it("spins a Kin by dragging without opening its Project", async () => {
    const onOpenProject = vi.fn();
    await render({
      entries: [entry("koed", "2026-11-03T11:59:00Z")],
      onOpenProject
    });
    await act(async () => {
      pointer(kin("koed"), "pointerdown", 0);
      pointer(kin("koed"), "pointermove", 40);
      pointer(kin("koed"), "pointerup", 40);
      kin("koed").click();
    });
    expect(onOpenProject).not.toHaveBeenCalled();
    await act(async () => kin("koed").click());
    expect(onOpenProject.mock.calls).toEqual([["koed"]]);
  });

  it("opens a Project from its Kin", async () => {
    const onOpenProject = vi.fn();
    await render({
      entries: [entry("koed", "2026-11-03T11:59:00Z")],
      onOpenProject
    });
    await act(async () => kin("koed").click());
    expect(onOpenProject.mock.calls).toEqual([["koed"]]);
  });

  it("points to the sidebar for Projects that don't fit on the stage", async () => {
    await render({
      entries: Array.from({ length: 10 }, (_, i) =>
        entry(`p${i}`, `2026-11-03T1${i % 10}:00:00Z`)
      )
    });
    expect(container.textContent).toContain("10 Projects");
    expect(container.textContent).toContain("3 more in the sidebar");
  });

  it("puts the most recently active Project in front", async () => {
    await render({
      entries: [
        entry("older", "2026-11-03T09:00:00Z"),
        entry("newer", "2026-11-03T11:00:00Z")
      ]
    });
    expect(front("newer")).toBe(true);
  });

  it("holds the order while the pointer is over the stage, then re-ranks", async () => {
    await render({
      entries: [
        entry("a", "2026-11-03T11:00:00Z"),
        entry("b", "2026-11-03T09:00:00Z")
      ]
    });
    const stage = container.querySelector(".v1-home-stage")!;
    await act(async () => {
      stage.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    await render({
      entries: [
        entry("a", "2026-11-03T11:00:00Z"),
        entry("b", "2026-11-03T11:59:00Z")
      ]
    });
    await act(async () => vi.advanceTimersByTime(HOME_RERANK_MS * 2));
    expect(front("a")).toBe(true);
    await act(async () => {
      stage.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(HOME_RERANK_MS));
    expect(front("b")).toBe(true);
  });

  it("feeds a Kin when its count rises, but not on first load", async () => {
    await render({ entries: [entry("a", "2026-11-03T11:00:00Z", 10)] });
    expect(container.querySelector(".v1-home-feed")).toBeNull();
    await render({ entries: [entry("a", "2026-11-03T12:00:00Z", 14)] });
    expect(container.querySelector(".v1-home-feed b")?.textContent).toBe("+4");
  });

  it("skips tile drops under reduced motion but still updates counts", async () => {
    reducedMotion = true;
    await render({ entries: [entry("a", "2026-11-03T11:00:00Z", 10)] });
    await render({ entries: [entry("a", "2026-11-03T12:00:00Z", 14)] });
    expect(container.querySelector(".v1-home-feed")).toBeNull();
    expect(kin("a").getAttribute("aria-label")).toContain("14 captured events");
  });

  it("shows ingestion counts with an indeterminate bar until the total is known", async () => {
    await render({
      entries: [entry("koed", "2026-11-03T11:00:00Z")],
      clients: [
        {
          id: "codex",
          name: "Codex",
          state: "connected",
          label: "Connected",
          version: null
        },
        {
          id: "claude",
          name: "Claude Code",
          state: "detected",
          label: "Detected · not connected",
          version: "2.1.312"
        }
      ],
      view: {
        kind: "ingesting",
        warnings: [],
        ingestion: {
          active: true,
          finished: 4,
          selected: null,
          clients: [
            {
              id: "codex",
              name: "Codex",
              lifecycle: "running",
              selected: null,
              completed: 2,
              skipped: 0,
              lastErrorCode: null,
              lastProgressAt: "2026-11-03T11:59:00Z",
              activity: { recordsRead: 45, embedded: 7, eligible: 20 },
              stuck: false
            },
            {
              id: "claude",
              name: "Claude Code",
              lifecycle: "failed",
              selected: 8,
              completed: 1,
              skipped: 1,
              lastErrorCode: "historical_ingestion_pass_failed",
              stuck: false
            }
          ]
        }
      }
    });
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain(
      "Up to 50 conversations"
    );
    const pills = [...container.querySelectorAll(".v1-home-pill")].map(
      (pill) => pill.textContent
    );
    expect(pills).toEqual(["2 finished", "Retrying · 2 of 8 finished"]);
    // Progress takes the pill, so connecting moves to the small line.
    expect(container.textContent).toContain("Connect · 2.1.312");
    expect(container.textContent).toContain("4 conversations finished");
    expect(container.textContent).toContain(
      "Reading history · 45 records read"
    );
    expect(container.textContent).toContain(
      "Making memories searchable · 7 of 20 items indexed so far"
    );
    const help = container.querySelector<HTMLButtonElement>(
      '[aria-label="Why conversations are skipped"]'
    )!;
    await act(async () => help.click());
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain(
      "too large or invalid"
    );
    await act(async () =>
      help.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    // One line: finished already includes skipped, so there is no separate
    // completed count; the "?" help sits after the skipped part.
    expect(container.textContent).toContain(
      "4 conversations finished · 1 skipped"
    );
    expect(container.textContent).not.toContain("completed");
    expect(container.textContent).toContain("Last activity 1m ago");
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.hasAttribute("data-indeterminate")).toBe(true);
    // Hatching is the Koed Kin alone: any Project switches Home to Projects.
    expect(
      container.querySelector('button[aria-label="Open Project koed"]')
    ).toBeNull();
    expect(container.querySelector("[data-coin-target]")).not.toBeNull();
  });

  const reading = (completed: number): HomeView => ({
    kind: "ingesting",
    warnings: [],
    ingestion: {
      active: true,
      finished: completed,
      selected: 10,
      clients: [
        {
          id: "codex",
          name: "Codex",
          lifecycle: "running",
          selected: 10,
          completed,
          skipped: 0,
          lastErrorCode: null,
          stuck: false
        }
      ]
    }
  });
  const codexClient = {
    id: "codex" as const,
    name: "Codex",
    state: "connected" as const,
    label: "Connected",
    version: null
  };

  it("drops coins from a client's keycap only when its progress rises", async () => {
    await render({ entries: [], view: reading(2), clients: [codexClient] });
    expect(container.querySelector(".v1-home-coin")).toBeNull();
    await render({ entries: [], view: reading(4), clients: [codexClient] });
    // happy-dom has no animations, so a coin lands as soon as it launches.
    expect(
      container.querySelectorAll(".v1-home-coin").length
    ).toBeLessThanOrEqual(3);
    await render({ entries: [], view: reading(4), clients: [codexClient] });
    expect(container.querySelector(".v1-home-coin")).toBeNull();
  });

  it("drops no coins under reduced motion", async () => {
    reducedMotion = true;
    const animate = vi.fn();
    Object.assign(HTMLElement.prototype, { animate });
    await render({ entries: [], view: reading(2), clients: [codexClient] });
    await render({ entries: [], view: reading(6), clients: [codexClient] });
    expect(container.querySelector(".v1-home-coin")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it("flies a coin for each update with animations available", async () => {
    const animations: { onfinish: (() => void) | null; cancel: () => void }[] =
      [];
    Object.assign(HTMLElement.prototype, {
      animate: () => {
        const animation = { onfinish: null, cancel: () => undefined };
        animations.push(animation);
        return animation;
      }
    });
    await render({ entries: [], view: reading(2), clients: [codexClient] });
    await render({ entries: [], view: reading(9), clients: [codexClient] });
    // Seven more: log2(8) = 3 coins, the cap.
    expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(3);
    await act(async () => animations.forEach((item) => item.onfinish?.()));
    expect(container.querySelector(".v1-home-coin")).toBeNull();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it("keeps history progress on the Projects view while it runs", async () => {
    const view = reading(3);
    await render({
      entries: [entry("koed", "2026-11-03T11:00:00Z")],
      clients: [codexClient],
      view: {
        kind: "projects",
        warnings: [],
        ingestion: view.kind === "ingesting" ? view.ingestion : undefined
      }
    });
    expect(container.textContent).toContain("Your Projects");
    expect(container.textContent).toContain("3 of 10 conversations finished");
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(
      [...container.querySelectorAll(".v1-home-pill")].map(
        (pill) => pill.textContent
      )
    ).toEqual(["3 of 10 finished"]);
    expect(container.querySelector("[data-coin-target]")).not.toBeNull();
  });

  it("says when history has stalled and when a client is only starting", async () => {
    const client = (
      id: "codex" | "claude",
      name: string,
      lifecycle: "running" | "failed",
      completed: number,
      stuck: boolean
    ) => ({
      id,
      name,
      lifecycle,
      selected: null,
      completed,
      skipped: 0,
      lastErrorCode: null,
      stuck
    });
    await render({
      entries: [],
      view: {
        kind: "ingesting",
        warnings: [],
        ingestion: {
          active: true,
          finished: 1,
          selected: null,
          clients: [
            client("codex", "Codex", "running", 0, false),
            client("claude", "Claude Code", "failed", 1, true)
          ]
        }
      },
      clients: [
        {
          id: "codex",
          name: "Codex",
          state: "connected",
          label: "Connected",
          version: null
        },
        {
          id: "claude",
          name: "Claude Code",
          state: "connected",
          label: "Connected",
          version: null
        }
      ]
    });
    expect(
      [...container.querySelectorAll(".v1-home-pill")].map(
        (pill) => pill.textContent
      )
    ).toEqual(["Starting", "Stuck · 1 finished"]);
    expect(container.textContent).toContain(
      "Claude Code history has stalled, so Koed keeps retrying."
    );
  });

  const claude = {
    id: "claude" as const,
    name: "Claude Code",
    state: "detected" as const,
    label: "Detected · not connected",
    version: "2.1.312"
  };

  it("connects a detected AI Client from its keycap after consent", async () => {
    const statusStore = new DesktopStatusStore();
    const run = vi.spyOn(statusStore, "run").mockResolvedValue({ ok: true });
    vi.spyOn(statusStore, "refresh").mockResolvedValue(null);
    await render({
      entries: [entry("koed", "2026-11-03T11:00:00Z")],
      clients: [claude],
      statusStore
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Connect Claude Code"]'
        )!
        .click()
    );
    expect(run).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Set up the Claude Code integration?"
    );
    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Set up Claude Code"
    )!;
    await act(async () => confirm.click());
    expect(run.mock.calls).toEqual([
      ["setup_claude", { operatorConsented: true }]
    ]);
  });

  it("offers to connect detected AI Clients on an empty stage", async () => {
    await render({
      entries: [],
      clients: [claude],
      view: { kind: "empty", warnings: [] }
    });
    expect(container.textContent).toContain("Connect an AI Client");
    expect(
      [...container.querySelectorAll(".v1-home-actions button")].map(
        (button) => button.textContent
      )
    ).toEqual(["Connect Claude Code"]);
  });

  it("asks before running a command that needs consent", async () => {
    const statusStore = new DesktopStatusStore();
    const run = vi.spyOn(statusStore, "run").mockResolvedValue(undefined);
    vi.spyOn(statusStore, "refresh").mockResolvedValue(null);
    const problem = {
      id: "runtime",
      title: "Local runtime",
      message: "Postgres stopped.",
      action: {
        command: "runtime_install" as const,
        label: "Install runtime",
        requiresConsent: true
      }
    };
    await render({
      entries: [],
      statusStore,
      view: { kind: "attention", problems: [problem], primary: problem }
    });
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Install runtime"
    )!;
    await act(async () => button.click());
    expect(run).not.toHaveBeenCalled();
    const proceed = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Continue"
    )!;
    await act(async () => proceed.click());
    expect(run).toHaveBeenCalledWith("runtime_install", {
      operatorConsented: true
    });
  });

  describe("dropping a floor coin on a Kin", () => {
    const loose = {
      key: "loose",
      title: "Loose chat",
      latestAt: "2026-11-03T00:00:00Z",
      client: null
    } as const;
    const press = (target: Element, type: string, clientX: number) =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          isPrimary: true,
          pointerId: 1,
          clientX,
          clientY: 0
        })
      );
    // happy-dom has no hit testing; the pointer is "over" whatever is set.
    let under: Element[] = [];
    beforeEach(() => {
      under = [];
      Object.defineProperty(document, "elementsFromPoint", {
        configurable: true,
        value: () => under
      });
    });
    afterEach(() => {
      delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
    });
    const setup = async (
      onDropConversation: (key: string, projectId: string) => Promise<boolean>
    ) => {
      reducedMotion = true;
      await render({
        entries: [entry("koed", "2026-11-03T11:59:00Z")],
        looseConversations: [loose],
        onOpenConversation: vi.fn(),
        onDropConversation
      });
      const coin = container.querySelector<HTMLElement>(".v1-home-floor-coin")!;
      await act(async () => {
        press(coin, "pointerdown", 0);
        press(coin, "pointermove", 60);
      });
      return { coin, target: kin("koed") };
    };

    it("adds the conversation only after half a second over the Kin", async () => {
      const onDrop = vi
        .fn<(key: string, projectId: string) => Promise<boolean>>()
        .mockResolvedValue(true);
      const { coin, target } = await setup(onDrop);
      under = [target];
      await act(async () => press(coin, "pointermove", 70));
      // Over the Kin, but not yet for long enough.
      expect(target.getAttribute("data-drop")).toBe("pending");
      await act(async () => vi.advanceTimersByTime(499));
      expect(target.getAttribute("data-drop")).toBe("pending");
      await act(async () => vi.advanceTimersByTime(1));
      expect(target.getAttribute("data-drop")).toBe("ready");
      expect(target.querySelector(".v1-home-kin-drop")?.textContent).toBe(
        "Add to koed"
      );
      await act(async () => press(coin, "pointerup", 70));
      expect(onDrop.mock.calls).toEqual([
        ["loose", target.dataset.dropProject]
      ]);
      expect(coin.dataset.motion).toBe("absorbed");
      expect(target.hasAttribute("data-drop")).toBe(false);
    });

    it("does nothing when let go before the wait is over", async () => {
      const onDrop = vi
        .fn<(key: string, projectId: string) => Promise<boolean>>()
        .mockResolvedValue(true);
      const { coin, target } = await setup(onDrop);
      under = [target];
      await act(async () => press(coin, "pointermove", 70));
      await act(async () => vi.advanceTimersByTime(300));
      await act(async () => press(coin, "pointerup", 70));
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(onDrop).not.toHaveBeenCalled();
      expect(coin.dataset.motion).toBe("rest");
      expect(target.hasAttribute("data-drop")).toBe(false);
    });

    it("restarts the wait when the coin leaves the Kin and returns", async () => {
      const onDrop = vi
        .fn<(key: string, projectId: string) => Promise<boolean>>()
        .mockResolvedValue(true);
      const { coin, target } = await setup(onDrop);
      under = [target];
      await act(async () => press(coin, "pointermove", 70));
      await act(async () => vi.advanceTimersByTime(400));
      under = [];
      await act(async () => press(coin, "pointermove", 200));
      expect(target.hasAttribute("data-drop")).toBe(false);
      under = [target];
      await act(async () => press(coin, "pointermove", 70));
      await act(async () => vi.advanceTimersByTime(400));
      expect(target.getAttribute("data-drop")).toBe("pending");
      await act(async () => press(coin, "pointerup", 70));
      expect(onDrop).not.toHaveBeenCalled();
    });

    it("puts the coin back on the floor when the add does not happen", async () => {
      const onDrop = vi
        .fn<(key: string, projectId: string) => Promise<boolean>>()
        .mockResolvedValue(false);
      const { coin, target } = await setup(onDrop);
      under = [target];
      await act(async () => press(coin, "pointermove", 70));
      await act(async () => vi.advanceTimersByTime(500));
      await act(async () => press(coin, "pointerup", 70));
      expect(onDrop).toHaveBeenCalledTimes(1);
      expect(coin.dataset.motion).toBe("rest");
    });
  });
});
