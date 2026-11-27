// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopStatusStore } from "../../services/desktop-commands.js";
import {
  DEFAULT_AGENT_LOOK,
  parseAgentLook,
  projectKinLook
} from "../pixelkin/agent-kin.js";
import { KinSpin } from "../onboarding/kin-spin.js";
import * as stage from "../pixelkin/stage.js";
import { fitRestingSpots, Home, HOME_RERANK_MS } from "./Home.js";
import type { HomeProjectEntry, HomeView } from "./home-model.js";

const agent = { name: "Koed", look: DEFAULT_AGENT_LOOK };
const projectsView: HomeView = { kind: "projects", warnings: [] };
const entry = (
  id: string,
  latestAt: string,
  eventCount = 10
): HomeProjectEntry => ({ id, name: id, eventCount, latestAt });

it("stops exhaustive resize searches after the first miss in each pass", () => {
  // At zero half-width, these two anchors cover the entire floor band.
  const resting = new Map([
    ["anchor-a", { x: 0, lane: 6.5 }],
    ["anchor-b", { x: 0, lane: 19.5 }],
    ["displaced-a", { x: 1, lane: 6.5 }],
    ["displaced-b", { x: 2, lane: 19.5 }]
  ]);
  const onScanLane = vi.fn<(lane: number) => void>();

  const { spots } = fitRestingSpots(resting, 0, onScanLane);

  // Only a full scan starts at lane zero.
  const fullScans = () => onScanLane.mock.calls.filter(([lane]) => lane === 0);
  expect(fullScans()).toHaveLength(1);
  expect(spots.get("displaced-a")?.lane).toBeCloseTo(8.4448, 4);
  expect(spots.get("displaced-b")?.lane).toBeCloseTo(15.1918, 4);

  fitRestingSpots(resting, 0, onScanLane);
  expect(fullScans()).toHaveLength(2);
});

it.each([
  { half: 0, fullSorts: 1 },
  { half: 20, fullSorts: 0 }
])(
  "sorts $fullSorts times when fitting to half-width $half",
  ({ half, fullSorts }) => {
    const resting = new Map([
      ["anchor-a", { x: 0, lane: 6.5 }],
      ["anchor-b", { x: 0, lane: 19.5 }],
      ["displaced-a", { x: 21, lane: 6.5 }],
      ["displaced-b", { x: 22, lane: 19.5 }]
    ]);
    const sort = vi.spyOn(Array.prototype, "sort");
    let calls: number;
    try {
      fitRestingSpots(resting, half);
      calls = sort.mock.calls.length;
    } finally {
      sort.mockRestore();
    }
    expect(calls).toBe(fullSorts);
  }
);

it("does not reuse a gap filled by an earlier fallback", () => {
  const resting = new Map([
    ["anchor-a", { x: 0, lane: 7 }],
    ["anchor-b", { x: 0, lane: 20 }],
    ["displaced-a", { x: 1, lane: 7 }],
    ["displaced-b", { x: 2, lane: 20 }]
  ]);

  const { spots } = fitRestingSpots(resting, 0);

  expect(spots.get("displaced-a")?.lane).toBe(0);
  expect(spots.get("displaced-b")?.lane).toBeCloseTo(15.1918, 4);
});

it("preserves a narrow gap found on a newly introduced lane after a miss", () => {
  const resting = new Map([
    ["anchor-a", { x: 0, lane: 5 }],
    ["anchor-b", { x: 0, lane: 8.44480075 }],
    ["anchor-c", { x: 0, lane: 22.44480125 }],
    ["displaced-a", { x: 1, lane: 5 }],
    ["displaced-b", { x: 2, lane: 5 }]
  ]);

  const { spots } = fitRestingSpots(resting, 0);

  expect(spots.get("displaced-a")?.lane).toBeCloseTo(8.4448, 7);
  expect(spots.get("displaced-b")?.lane).toBeCloseTo(15.444801, 7);
});

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
    if (view.kind === "attention") return;
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

  it("loads with the large shadcn spinner and no Kin or recovery buttons", async () => {
    await render({ entries: [], view: { kind: "loading" } });
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(
      container.querySelector('.v1-home-spinner[role="status"]')
    ).not.toBeNull();
    expect(container.textContent).toContain("Making room for your Projects");
    expect(container.querySelector(".v1-pixelkin")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows a sad Kin and a neutral shadcn button that starts Koed", async () => {
    const statusStore = new DesktopStatusStore();
    const run = vi.spyOn(statusStore, "run").mockResolvedValue(undefined);
    const problem: import("./home-model.js").HomeProblem = {
      id: "services",
      title: "Koed services",
      message: "Koed isn’t running.",
      action: { command: "start", label: "Start Koed", requiresConsent: false }
    };
    await render({
      entries: [],
      statusStore,
      view: { kind: "attention", problems: [problem], primary: problem }
    });
    expect(container.querySelector('[data-expression="sad"]')).not.toBeNull();
    const button = container.querySelector<HTMLButtonElement>(
      '[data-slot="button"]'
    )!;
    expect(button.textContent).toBe("Start Koed");
    expect(button.className).toContain("bg-popover");
    expect(button.className).not.toContain("bg-primary");
    await act(async () => button.click());
    expect(run).toHaveBeenCalledWith("start", undefined);
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

  it("pauses polling while hidden and refreshes when visible again", async () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const statusStore = new DesktopStatusStore();
    const refresh = vi.spyOn(statusStore, "refresh").mockResolvedValue(null);
    await render({
      entries: [],
      view: { kind: "empty", warnings: [] },
      statusStore
    });
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    hidden = true;
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    hidden = false;
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(15_000));
    expect(refresh).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    expect(refresh).toHaveBeenCalledTimes(3);
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
    // Newest first; the tooltip names it, with its client's logo and how
    // long ago it was active.
    expect(coins.map((coin) => coin.getAttribute("aria-label"))).toEqual([
      "Open Pi OAuth and Extension Repair",
      "Open Older loose chat"
    ]);
    expect(coins[0]!.querySelector(".v1-home-floor-title")?.textContent).toBe(
      "Pi OAuth and Extension Repair"
    );
    expect(coins[0]!.querySelector(".v1-home-floor-ago")?.textContent).toBe(
      "12h ago"
    );
    expect(coins[1]!.querySelector(".v1-home-floor-ago")?.textContent).toBe(
      "3d ago"
    );
    expect(coins[0]!.querySelector(".v1-home-floor-client")).not.toBeNull();
    expect(coins[1]!.querySelector(".v1-home-floor-client")).toBeNull();
    await act(async () => coins[0]!.click());
    expect(onOpenConversation.mock.calls).toEqual([["newer"]]);
  });

  it("keeps Home mounted with SVG coins when the first WebGL draw throws", async () => {
    const draw = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("WebGL context lost");
      })
      .mockReturnValue(null);
    vi.spyOn(stage, "pixelkinEngineAvailable").mockReturnValue(true);
    vi.spyOn(stage, "sharedKinRenderer").mockReturnValue({
      render: draw,
      canvas: document.createElement("canvas"),
      available: true,
      ready: Promise.resolve(),
      gl: null
    });
    const onOpenConversation = vi.fn();
    await render({
      entries: [],
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

    expect(draw).toHaveBeenCalled();
    const coin = container.querySelector<HTMLButtonElement>(
      ".v1-home-floor-coin"
    )!;
    expect(coin.querySelectorAll(".v1-coin-vector > svg")).toHaveLength(2);
    await act(async () => coin.click());
    expect(onOpenConversation).toHaveBeenCalledWith("loose");
  });

  it("does not cache coin artwork when a completed draw loses WebGL", async () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      clearRect: vi.fn()
    } as unknown as CanvasRenderingContext2D);
    const draw = vi.fn().mockReturnValue(canvas);
    const gl = { isContextLost: () => true } as WebGL2RenderingContext;
    vi.spyOn(stage, "pixelkinEngineAvailable").mockReturnValue(true);
    vi.spyOn(stage, "sharedKinRenderer").mockReturnValue({
      render: draw,
      canvas,
      available: true,
      ready: Promise.resolve(),
      gl
    });
    const conversation = {
      title: "Loose chat",
      latestAt: "2026-11-02T00:00:00Z",
      client: null
    };
    await render({
      entries: [],
      looseConversations: [
        { ...conversation, key: "first" },
        { ...conversation, key: "second" }
      ],
      onOpenConversation: vi.fn()
    });

    expect(draw).toHaveBeenCalledTimes(4);
    expect(
      container.querySelectorAll(".v1-home-floor-coin .v1-coin-vector > svg")
    ).toHaveLength(4);
  });

  const pointer = (
    target: Element,
    type: string,
    clientX: number,
    clientY = 0,
    pointerId = 1
  ) => {
    const event = new PointerEvent(type, {
      bubbles: true,
      button: 0,
      isPrimary: true,
      pointerId,
      clientX,
      clientY
    });
    // Pointer samples carry hardware timestamps; follow the fake clock.
    Object.defineProperty(event, "timeStamp", { value: performance.now() });
    return target.dispatchEvent(event);
  };

  // A coin's offset from the stage centre, from `calc(50% + Npx)`.
  const offsetOf = (coin: HTMLElement) =>
    parseFloat(
      /([-\d.]+)px/.exec(coin.style.getPropertyValue("--coin-x"))?.[1] ?? "0"
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

  it("keeps a flick's speed with 1,000 Hz pointer samples", async () => {
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
    const left = () => offsetOf(coin);
    await act(async () => {
      pointer(coin, "pointerdown", 0, 0);
      // A steady 1ms cadence, 3px per sample: 3,000px/s for 20ms.
      for (let step = 1; step <= 20; step += 1) {
        vi.advanceTimersByTime(1);
        pointer(coin, "pointermove", step * 3, 0);
      }
      pointer(coin, "pointerup", 60, 0);
    });
    const released = left();
    await act(async () => vi.advanceTimersByTime(100));
    // Carried on in the flick's direction instead of dropping straight down.
    expect(left()).toBeGreaterThan(released + 20);
  });

  describe("loose coin arrivals", () => {
    const looseProps = (loose: HomeLooseConversationInput[]) => ({
      entries: [entry("koed", "2026-11-03T11:59:00Z")],
      conversations: [],
      looseConversations: loose,
      onOpenConversation: () => undefined
    });
    type HomeLooseConversationInput = {
      key: string;
      aliases?: string[];
      title: string;
      latestAt: string;
      client: "codex" | null;
    };
    const item = (key: string, aliases: string[] = []) => ({
      key,
      aliases,
      title: key,
      latestAt: "2026-11-03T00:00:00Z",
      client: null
    });
    const coinFor = (key: string) =>
      container.querySelector<HTMLElement>(
        `[data-coin-conversation="${key}"]`
      )!;

    it("throws the first Conversation to arrive on a loaded, empty floor", async () => {
      await render(looseProps([]));
      await render(looseProps([item("first")]));
      expect(coinFor("first").dataset.motion).toBe("flying");
    });

    it("does not throw a Conversation again when it gets its permanent key", async () => {
      await render(looseProps([item("draft")]));
      await render(looseProps([item("real", ["draft"])]));
      expect(coinFor("real").dataset.motion).toBe("rest");
    });

    it("waits for the complete inventory before treating coins as new", async () => {
      // A named-Project preview shows the floor before the old Conversations
      // are all there; none of them are arrivals when the full list lands.
      await render({ ...looseProps([item("old-a")]), conversationScope: null });
      await render({
        ...looseProps([item("old-a"), item("old-b"), item("old-c")]),
        conversationScope: "home"
      });
      for (const key of ["old-a", "old-b", "old-c"])
        expect(coinFor(key).dataset.motion).toBe("rest");
      // A genuinely new one after that is still thrown.
      await render(
        looseProps([item("old-a"), item("old-b"), item("old-c"), item("new")])
      );
      expect(coinFor("new").dataset.motion).toBe("flying");
    });

    it("places reduced-motion arrivals in free spots", async () => {
      reducedMotion = true;
      await render(looseProps([]));
      const arrivals = Array.from({ length: 12 }, (_, i) => item(`conv-${i}`));
      await render(looseProps(arrivals));
      const spots = arrivals.map(({ key }) => {
        const coin = coinFor(key);
        expect(coin.dataset.motion).toBe("rest");
        return {
          x: offsetOf(coin),
          depth: parseFloat(coin.style.getPropertyValue("--coin-depth")) * 26
        };
      });
      for (const [i, a] of spots.entries())
        for (const b of spots.slice(i + 1))
          expect(
            Math.abs(a.x - b.x) >= 14 || Math.abs(a.depth - b.depth) >= 7
          ).toBe(true);
    });

    const measureStage = (initialWidth: number) => {
      let width = initialWidth;
      let measure: () => void;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            measure = callback;
          }
          observe() {}
          disconnect() {}
        }
      );
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect"
      ).mockImplementation(function (this: HTMLElement) {
        if (this.matches(".v1-home-stage, .v1-home-floor"))
          return new DOMRect(0, 0, width, width ? 500 : 0);
        return new DOMRect();
      });
      return async (nextWidth: number) => {
        width = nextWidth;
        await act(async () => measure());
      };
    };

    const spotOf = (key: string) => {
      const coin = coinFor(key);
      expect(coin.dataset.motion).toBe("rest");
      return {
        x: offsetOf(coin),
        lane: parseFloat(coin.style.getPropertyValue("--coin-depth")) * 26
      };
    };

    it("keeps a preview coin still when a new coin lands beside it", async () => {
      measureStage(900);
      // This key starts near the center and shares a lane with the new coin.
      const old = item("old-636");
      await render({ ...looseProps([old]), conversationScope: null });
      const preview = coinFor(old.key);
      const before = spotOf(old.key);
      await render(looseProps([old]));
      expect(coinFor(old.key)).toBe(preview);
      expect(spotOf(old.key)).toEqual(before);

      // Throw straight up so the new coin comes down beside the preview coin.
      vi.spyOn(Math, "random").mockReturnValue(0.25);
      await render(looseProps([old, item("new")]));
      expect(coinFor("new").dataset.motion).toBe("flying");
      expect(spotOf(old.key)).toEqual(before);
      await act(async () => vi.advanceTimersByTime(2000));
      expect(coinFor("new").dataset.motion).toBe("rest");
      expect(spotOf(old.key)).toEqual(before);
    });

    it.each([900, 0])(
      "separates clamped floor coins on measuring 600px after width %i",
      async (initialWidth) => {
        const resize = measureStage(initialWidth);
        await render(
          looseProps([item("conv-10"), item("conv-13"), item("loose")])
        );
        const first = spotOf("conv-10");
        const second = spotOf("conv-13");
        const inBounds = spotOf("loose");
        expect(first.x).toBeGreaterThan(260);
        expect(second.x).toBeGreaterThan(260);

        await resize(600);
        const clamped = spotOf("conv-10");
        const moved = spotOf("conv-13");
        expect(spotOf("loose")).toEqual(inBounds);
        expect(clamped).toEqual({ x: 260, lane: first.lane });
        expect(Math.abs(moved.x)).toBeLessThanOrEqual(260);
        expect(
          Math.abs(clamped.x - moved.x) >= 14 ||
            Math.abs(clamped.lane - moved.lane) >= 7
        ).toBe(true);

        await resize(900);
        expect(spotOf("conv-10")).toEqual(clamped);
        expect(spotOf("conv-13")).toEqual(moved);
      }
    );

    it("reserves in-bounds spots before clamping earlier cached coins", async () => {
      const resize = measureStage(900);
      await render(looseProps([item("conv-10"), item("conv-81")]));
      const inBounds = spotOf("conv-81");
      await resize(600);
      expect(spotOf("conv-81")).toEqual(inBounds);
      const moved = spotOf("conv-10");
      expect(
        Math.abs(inBounds.x - moved.x) >= 14 ||
          Math.abs(inBounds.lane - moved.lane) >= 7
      ).toBe(true);
    });

    it("finds a free spot when resize placement samples all clash", async () => {
      const resize = measureStage(900);
      const keys = Array.from(
        { length: 25 },
        (_, i) => `seed-483-conv-${i}`
      ).sort();
      await render(looseProps(keys.map((key) => item(key))));
      await resize(600);
      const spots = keys.map(spotOf);
      for (const [i, a] of spots.entries())
        for (const b of spots.slice(i + 1))
          expect(
            Math.abs(a.x - b.x) >= 14 || Math.abs(a.lane - b.lane) >= 7
          ).toBe(true);
    });

    it.each([false, true])(
      "uses measured bounds for a thrown coin (resize during flight: %s)",
      async (duringFlight) => {
        const resize = measureStage(900);
        await render(looseProps([item("loose")]));
        const coin = coinFor("loose");
        await act(async () => {
          pointer(coin, "pointerdown", 450, 100);
          pointer(coin, "pointermove", 810, 100);
          pointer(coin, "pointerup", 810, 100);
          vi.advanceTimersByTime(16);
        });
        expect(coin.dataset.motion).toBe("flying");
        if (duringFlight) {
          await resize(600);
          expect(coinFor("loose")).toBe(coin);
          expect(coin.dataset.motion).toBe("flying");
        }
        await act(async () => vi.advanceTimersByTime(2000));
        if (!duringFlight) {
          expect(spotOf("loose").x).toBe(360);
          await resize(600);
        }
        const corrected = spotOf("loose");
        expect(corrected.x).toBe(260);
        await resize(900);
        expect(spotOf("loose")).toEqual(corrected);
      }
    );

    it("leaves a landed coin at rest when the stage changes under it", async () => {
      await render(looseProps([]));
      await render(looseProps([item("landed")]));
      expect(coinFor("landed").dataset.motion).toBe("flying");
      for (let frame = 0; frame < 600; frame += 1)
        await act(async () => vi.advanceTimersByTime(16));
      const rest = coinFor("landed").style.getPropertyValue("--coin-x");
      expect(coinFor("landed").dataset.motion).toBe("rest");
      // Projects appear: the solo stage becomes the Projects stage.
      await render({
        ...looseProps([item("landed")]),
        entries: [entry("koed", "2026-11-03T11:59:00Z")],
        view: projectsView
      });
      expect(coinFor("landed").dataset.motion).toBe("rest");
      expect(coinFor("landed").style.getPropertyValue("--coin-x")).toBe(rest);
    });

    it("leaves coins already on the floor at load at rest", async () => {
      await render(looseProps([item("old")]));
      expect(coinFor("old").dataset.motion).toBe("rest");
    });
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

  it("accepts a new Kin drag after pointer capture is lost", async () => {
    const onOpenProject = vi.fn();
    await render({
      entries: [entry("koed", "2026-11-03T11:59:00Z")],
      onOpenProject
    });
    await act(async () => {
      pointer(kin("koed"), "pointerdown", 0);
      pointer(kin("koed"), "lostpointercapture", 0);
      pointer(kin("koed"), "pointerdown", 0, 0, 2);
      pointer(kin("koed"), "pointermove", 40, 0, 2);
      pointer(kin("koed"), "pointerup", 40, 0, 2);
      kin("koed").click();
    });
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it("releases timed-out Kin capture and accepts another drag", async () => {
    const onOpenProject = vi.fn();
    const begin = vi.spyOn(KinSpin.prototype, "begin");
    await render({
      entries: [entry("koed", "2026-11-03T11:59:00Z")],
      onOpenProject
    });
    const button = kin("koed");
    let captured = false;
    button.setPointerCapture = () => {
      captured = true;
    };
    button.hasPointerCapture = () => captured;
    button.releasePointerCapture = () => {
      captured = false;
    };
    await act(async () => pointer(button, "pointerdown", 0));
    expect(captured).toBe(true);
    await act(async () => {
      (begin.mock.contexts[0] as KinSpin).step(2, false);
      vi.advanceTimersByTime(50);
    });
    expect(captured).toBe(false);
    await act(async () => {
      pointer(button, "pointerdown", 0, 0, 2);
      pointer(button, "pointermove", 40, 0, 2);
      pointer(button, "pointerup", 40, 0, 2);
      button.click();
    });
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it("uses the legacy profile for the solo host and the Project ID for an uncustomized Kin", async () => {
    const oldAgent = {
      name: "Pip",
      look: parseAgentLook('{"shape":"tall","color":"mint"}')
    };
    await render({ entries: [], view: { kind: "empty", warnings: [] } });
    expect(container.textContent).toContain("Koed");
    await render({
      entries: [],
      view: { kind: "empty", warnings: [] },
      agent: oldAgent
    });
    expect(
      container
        .querySelector(".v1-home-host .v1-pixelkin")
        ?.getAttribute("data-kin-colour")
    ).toBe(oldAgent.look.palette.base);
    const spin = vi.spyOn(KinSpin.prototype, "move");
    const host = container.querySelector<HTMLElement>(".v1-home-host")!;
    await act(async () => {
      pointer(host, "pointerdown", 0);
      pointer(host, "pointermove", 40);
      pointer(host, "pointerup", 40);
    });
    expect(spin).toHaveBeenCalledWith(40, expect.any(Number));
    await render({
      entries: [entry("older", "2026-11-03T09:00:00Z")],
      agent: oldAgent
    });
    expect(
      kin("older")
        .querySelector(".v1-pixelkin")
        ?.getAttribute("data-kin-colour")
    ).toBe(projectKinLook("older").palette.base);
  });

  it("keeps the saved Kin and its destination together through a rename and rerank", async () => {
    const onOpenProject = vi.fn();
    const saved = {
      shape: "capsule",
      colour: "#123456",
      personality: "sleepy"
    } as const;
    const a = { ...entry("a", "2026-11-03T11:00:00Z"), kin: saved };
    const b = entry("b", "2026-11-03T09:00:00Z");
    await render({ entries: [a, b], onOpenProject });
    expect(front("a")).toBe(true);
    const otherColour = kin("b")
      .querySelector(".v1-pixelkin")!
      .getAttribute("data-kin-colour");
    await render({
      entries: [
        { ...a, name: "Renamed" },
        { ...b, latestAt: "2026-11-03T11:59:00Z" }
      ],
      onOpenProject
    });
    await act(async () => vi.advanceTimersByTime(HOME_RERANK_MS));
    expect(front("b")).toBe(true);
    expect(
      kin("Renamed").querySelector(
        '[data-kin-shape="capsule"][data-kin-colour="#123456"]'
      )
    ).not.toBeNull();
    expect(
      kin("b").querySelector(".v1-pixelkin")!.getAttribute("data-kin-colour")
    ).toBe(otherColour);
    await act(async () => {
      kin("Renamed").click();
      kin("b").click();
    });
    expect(onOpenProject.mock.calls).toEqual([["a"], ["b"]]);
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

  it("shows the Projects stage without a heading or Project count", async () => {
    await render({
      entries: Array.from({ length: 10 }, (_, i) =>
        entry(`p${i}`, `2026-11-03T1${i % 10}:00:00Z`)
      )
    });
    expect(container.textContent).not.toContain("Your Projects");
    expect(container.textContent).not.toContain("10 Projects");
    expect(container.textContent).not.toContain("captured events");
    expect(container.querySelector(".v1-home-caption")?.textContent).toBe("");
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
      entries: [],
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
    expect(container.querySelector(".v1-home-spinner")).not.toBeNull();
    expect(container.querySelector(".v1-pixelkin")).toBeNull();
    expect(container.textContent).toContain("4 found conversations processed");
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
      "4 found conversations processed · 1 skipped"
    );
    expect(container.textContent).not.toContain("completed");
    expect(container.textContent).not.toContain("Last activity");
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.hasAttribute("data-indeterminate")).toBe(true);
    // History preparation uses the same spinner, without a separate Kin stage.
    expect(
      container.querySelector('button[aria-label="Open Project koed"]')
    ).toBeNull();
    expect(container.querySelector("[data-coin-target]")).toBeNull();
  });

  const reading = (
    completed: number
  ): Extract<HomeView, { kind: "ingesting" }> => ({
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
  const projectReading = (completed: number): HomeView => ({
    kind: "projects",
    warnings: [],
    ingestion: reading(completed).ingestion
  });
  const codexClient = {
    id: "codex" as const,
    name: "Codex",
    state: "connected" as const,
    label: "Connected",
    version: null
  };

  it("keeps the spinner mounted through history preparation and opens Projects directly", async () => {
    await render({ entries: [], view: { kind: "loading" } });
    const spinner = container.querySelector(".v1-home-spinner");
    await render({ entries: [], view: reading(2) });
    expect(container.querySelector(".v1-home-spinner")).toBe(spinner);
    expect(container.textContent).toContain("Making room for your Projects");
    expect(container.textContent).not.toContain("Hatching");
    expect(container.querySelector(".v1-pixelkin")).toBeNull();
    await render({
      entries: [entry("a", "2026-11-03T11:00:00Z")],
      view: projectsView
    });
    expect(container.querySelector(".v1-home-stage-top")).not.toBeNull();
    expect(container.querySelector(".v1-home-spinner")).toBeNull();
  });

  it("keeps import progress separate from the window's Chief of Staff avatar", async () => {
    const entries = [entry("koed", "2026-11-03T11:00:00Z")];
    for (const view of [reading(2), projectReading(2)]) {
      await render({ entries, view, showStageHost: false });
      if (view.kind === "projects") {
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>(".v1-home-top-progress button")!
            .focus()
        );
      }
      expect(
        container.querySelector('.v1-home-progress [role="progressbar"]')
      ).not.toBeNull();
      expect(
        container.querySelector(".v1-home-progress .v1-pixelkin")
      ).toBeNull();
    }
    await render({
      entries: [],
      view: { kind: "empty", warnings: [] },
      showStageHost: false
    });
    expect(container.querySelector(".v1-home-host .v1-pixelkin")).toBeNull();
  });

  it("does not produce coins when only ingestion progress rises", async () => {
    await render({ entries: [], view: reading(2), clients: [codexClient] });
    expect(container.querySelector(".v1-home-coin")).toBeNull();
    await render({ entries: [], view: reading(4), clients: [codexClient] });
    expect(container.querySelector(".v1-home-coin")).toBeNull();
    await render({ entries: [], view: reading(4), clients: [codexClient] });
    expect(container.querySelector(".v1-home-coin")).toBeNull();
  });

  it("drops no coins under reduced motion", async () => {
    reducedMotion = true;
    const animate = vi.fn();
    Object.assign(HTMLElement.prototype, { animate });
    await render({
      entries: [entry("existing", "2026-11-03T11:00:00Z")],
      view: projectReading(2),
      clients: [codexClient]
    });
    await render({
      entries: [entry("existing", "2026-11-03T11:00:00Z")],
      view: projectReading(6),
      clients: [codexClient]
    });
    expect(container.querySelector(".v1-home-coin")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  // A Project Kin for coins to fly to, added to the stage.
  const addProjectKin = async () => {
    const project = document.createElement("div");
    project.dataset.coinProject = "project";
    const kin = document.createElement("div");
    kin.className = "v1-pixelkin";
    project.append(kin);
    await act(async () => {
      container.querySelector(".v1-home-coins")!.parentElement!.append(project);
    });
  };

  it("flies a coin for a newly appearing sidebar Conversation, not ingestion progress", async () => {
    const animations: { onfinish: (() => void) | null; cancel: () => void }[] =
      [];
    Object.assign(HTMLElement.prototype, {
      animate: () => {
        const animation = { onfinish: null, cancel: () => undefined };
        animations.push(animation);
        return animation;
      }
    });
    const existing = {
      key: "old",
      aliases: ["old"],
      client: "codex" as const,
      projectIds: ["project"]
    };
    const added = {
      key: "new",
      aliases: ["new"],
      client: "codex" as const,
      projectIds: ["project"]
    };
    await render({
      entries: [entry("existing", "2026-11-03T11:00:00Z")],
      view: projectReading(2),
      clients: [codexClient],
      conversations: [existing]
    });
    await addProjectKin();
    await render({
      entries: [entry("existing", "2026-11-03T11:00:00Z")],
      view: projectReading(9),
      clients: [codexClient],
      conversations: [existing]
    });
    expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(0);
    await render({
      entries: [entry("existing", "2026-11-03T11:00:00Z")],
      view: projectReading(9),
      clients: [codexClient],
      conversations: [existing, added]
    });
    expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(1);
    await act(async () => animations.forEach((item) => item.onfinish?.()));
    expect(container.querySelector(".v1-home-coin")).toBeNull();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it("queues large batches and starts queued coins as flights finish", async () => {
    const animations: { onfinish: (() => void) | null; cancel: () => void }[] =
      [];
    Object.assign(HTMLElement.prototype, {
      animate: () => {
        const animation = { onfinish: null, cancel: () => undefined };
        animations.push(animation);
        return animation;
      }
    });
    const props = {
      entries: [entry("existing", "2026-11-03T11:00:00Z")],
      view: projectReading(2),
      clients: [codexClient],
      conversationScope: "one"
    };
    await render({ ...props, conversations: [] });
    await addProjectKin();
    const conversations = Array.from({ length: 12 }, (_, i) => ({
      key: `new-${i}`,
      aliases: [],
      client: "codex" as const,
      projectIds: ["project"]
    }));
    await render({ ...props, conversations });
    expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(4);
    await act(async () => animations[0]?.onfinish?.());
    expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(4);
    expect(animations).toHaveLength(5);
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it("flies only one coin for aliases in the same update", async () => {
    Object.assign(HTMLElement.prototype, {
      animate: () => ({ onfinish: null, cancel: () => undefined })
    });
    const props = {
      entries: [entry("existing", "2026-11-03T11:00:00Z")],
      view: projectReading(2),
      clients: [codexClient],
      conversationScope: "one"
    };
    await render({ ...props, conversations: [] });
    await addProjectKin();
    await render({
      ...props,
      conversations: [
        {
          key: "first",
          aliases: ["shared"],
          client: "codex",
          projectIds: ["project"]
        },
        {
          key: "second",
          aliases: ["shared"],
          client: "codex",
          projectIds: ["project"]
        }
      ]
    });
    expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(1);
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it.each(["keycap", "kin"])(
    "retries when %s appears last without a render",
    async (last) => {
      Object.assign(HTMLElement.prototype, {
        animate: () => ({ onfinish: null, cancel: () => undefined })
      });
      const props = {
        entries: [entry("existing", "2026-11-03T11:00:00Z")],
        view: projectReading(2),
        clients: [codexClient],
        conversationScope: "one"
      };
      await render({ ...props, conversations: [] });
      const keycap = container.querySelector<HTMLElement>(
        '.v1-home-keycap[data-client="codex"]'
      )!;
      const parent = keycap.parentElement!;
      await act(async () => keycap.remove());
      await render({
        ...props,
        conversations: [
          { key: "new", aliases: [], client: "codex", projectIds: ["project"] }
        ]
      });
      const project = document.createElement("div");
      project.dataset.coinProject = "project";
      await act(async () => {
        container
          .querySelector(".v1-home-coins")!
          .parentElement!.append(project);
      });
      const kin = document.createElement("div");
      kin.className = "v1-pixelkin";
      if (last === "keycap")
        await act(async () => {
          project.append(kin);
        });
      else
        await act(async () => {
          parent.append(keycap);
        });
      expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(0);
      if (last === "keycap")
        await act(async () => {
          parent.append(keycap);
        });
      else
        await act(async () => {
          project.append(kin);
        });
      expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(1);
      await act(async () => {
        project.append(document.createElement("div"));
      });
      expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(1);
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  );

  it("throws a new loose Conversation as a floor coin, not a flying coin", async () => {
    const frames: Keyframe[][] = [];
    Object.assign(HTMLElement.prototype, {
      animate: (keyframes: Keyframe[]) => {
        frames.push(keyframes);
        return { onfinish: null, cancel: () => undefined };
      }
    });
    const props = {
      entries: [],
      view: { kind: "empty" as const, warnings: [] },
      clients: [codexClient],
      conversationScope: "one",
      onOpenConversation: () => undefined
    };
    const loose = (key: string) => ({
      key,
      title: key,
      latestAt: "2026-11-03",
      client: "codex" as const
    });
    await render({
      ...props,
      conversations: [
        { key: "old", aliases: [], client: "codex", projectIds: [] }
      ],
      looseConversations: [loose("old")]
    });
    const many = Array.from({ length: 30 }, (_, i) => loose(`c${i}`));
    await render({
      ...props,
      conversations: many.map(({ key }) => ({
        key,
        aliases: [],
        client: "codex" as const,
        projectIds: []
      })),
      looseConversations: [loose("old"), ...many]
    });
    // No cap on floor coins, and none fly along an arc to a landing spot.
    expect(container.querySelectorAll(".v1-home-floor-coin")).toHaveLength(31);
    expect(frames).toHaveLength(0);
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it("retries a new Conversation when its Project Kin appears later", async () => {
    Object.assign(HTMLElement.prototype, {
      animate: () => ({ onfinish: null, cancel: () => undefined })
    });
    const added = {
      key: "new",
      aliases: ["new"],
      client: "codex" as const,
      projectIds: ["project"]
    };
    const props = { clients: [codexClient], conversationScope: "one" };
    await render({
      ...props,
      entries: [],
      view: { kind: "empty", warnings: [] },
      conversations: []
    });
    await render({
      ...props,
      entries: [],
      view: { kind: "empty", warnings: [] },
      conversations: [added]
    });
    expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(0);
    await render({
      ...props,
      entries: [entry("project", "2026-11-03T12:00:00Z")],
      conversations: [added]
    });
    expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(1);
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it("baselines hydration and scope changes, and skips missing clients", async () => {
    Object.assign(HTMLElement.prototype, {
      animate: () => ({ onfinish: null, cancel: () => undefined })
    });
    const conversation = (key: string, client: "codex" | null = "codex") => ({
      key,
      aliases: [key],
      client,
      projectIds: []
    });
    await render({
      entries: [],
      view: { kind: "empty", warnings: [] },
      clients: [codexClient],
      conversationScope: null,
      conversations: []
    });
    await render({
      entries: [],
      view: { kind: "empty", warnings: [] },
      clients: [codexClient],
      conversationScope: "one",
      conversations: [conversation("old")]
    });
    expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(0);
    await render({
      entries: [],
      view: { kind: "empty", warnings: [] },
      clients: [codexClient],
      conversationScope: "one",
      conversations: [conversation("old"), conversation("unknown", null)]
    });
    expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(0);
    await render({
      entries: [],
      view: { kind: "empty", warnings: [] },
      clients: [codexClient],
      conversationScope: "two",
      conversations: [conversation("other")]
    });
    expect(container.querySelectorAll(".v1-home-coin")).toHaveLength(0);
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
    const chip = container.querySelector<HTMLButtonElement>(
      ".v1-home-top-progress button"
    )!;
    const bar = () => container.querySelector('[role="progressbar"]');
    expect(bar()).toBeNull();
    const keycap = container.querySelector(".v1-home-keycap")!;
    expect(
      container.querySelector(".v1-home-keycaps .v1-home-pill")
    ).toBeNull();
    expect(
      keycap.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    await act(async () =>
      chip.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })
      )
    );
    expect(bar()).not.toBeNull();
    await act(async () =>
      chip.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })
      )
    );
    expect(bar()).toBeNull();
    await act(async () => chip.focus());
    expect(bar()).not.toBeNull();
    await act(async () => chip.click());
    await act(async () => chip.blur());
    expect(container.textContent).toContain(
      "3 of 10 found conversations processed"
    );
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(bar()).toBeNull();
    expect(container.querySelector("[data-coin-target]")).not.toBeNull();
  });

  it("keeps stalled history guidance on the shared loading screen", async () => {
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
    expect(container.querySelector(".v1-home-spinner")).not.toBeNull();
    expect(container.querySelector(".v1-pixelkin")).toBeNull();
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
    const refresh = vi.spyOn(statusStore, "refresh").mockResolvedValue(null);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
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
    expect(refresh).toHaveBeenCalledTimes(1);
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

  it("repairs an AI Client from the Repair link under its keycap", async () => {
    const statusStore = new DesktopStatusStore();
    const run = vi.spyOn(statusStore, "run").mockResolvedValue({ ok: true });
    vi.spyOn(statusStore, "refresh").mockResolvedValue(null);
    await render({
      entries: [entry("koed", "2026-11-03T11:00:00Z")],
      clients: [
        {
          id: "codex",
          name: "Codex",
          state: "attention",
          repairable: true,
          label:
            "Codex Koed integration points at a different Local AI Runtime.",
          version: null
        }
      ],
      statusStore,
      view: {
        kind: "projects",
        warnings: [],
        ingestion: {
          active: true,
          finished: 14,
          selected: 50,
          clients: [
            {
              id: "codex",
              name: "Codex",
              lifecycle: "waiting",
              selected: 50,
              completed: 14,
              skipped: 0,
              lastErrorCode: null,
              stuck: false
            }
          ]
        }
      }
    });
    // The keycap is the only place the problem is flagged.
    expect(container.querySelector(".v1-home-warnings")).toBeNull();
    const repair = container.querySelector<HTMLButtonElement>(
      '.v1-home-keycaps small button[aria-label="Repair Codex"]'
    )!;
    expect(repair.textContent).toBe("Repair");
    await act(async () => repair.click());
    expect(run).not.toHaveBeenCalled();
    const confirm = container.querySelector<HTMLButtonElement>(
      '.v1-home-consent[role="dialog"] .v1-home-primary'
    )!;
    await act(async () => confirm.click());
    expect(run.mock.calls).toEqual([
      ["repair_codex", { operatorConsented: true }]
    ]);
  });

  it("closes the warnings list on an outside click or Escape", async () => {
    await render({
      entries: [entry("koed", "2026-11-03T11:00:00Z")],
      view: {
        kind: "projects",
        warnings: [
          {
            id: "capture-hook",
            title: "Capture Hook",
            message: "Hook is quiet.",
            action: null
          }
        ]
      }
    });
    const chip = container.querySelector<HTMLButtonElement>(".v1-home-chip")!;
    const list = () => container.querySelector(".v1-home-problems");
    expect(chip.textContent).toBe("Check Capture Hook");
    await act(async () => chip.click());
    expect(list()).not.toBeNull();
    // Inside the list stays open.
    await act(async () => {
      list()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(list()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true })
      );
    });
    expect(list()).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    await act(async () => chip.click());
    expect(list()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(list()).toBeNull();
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

    it.each(["pointercancel", "lostpointercapture"])(
      "does not add the conversation when the drag ends with %s",
      async (type) => {
        const onDrop = vi
          .fn<(key: string, projectId: string) => Promise<boolean>>()
          .mockResolvedValue(true);
        const { coin, target } = await setup(onDrop);
        under = [target];
        await act(async () => press(coin, "pointermove", 70));
        await act(async () => vi.advanceTimersByTime(500));
        expect(target.getAttribute("data-drop")).toBe("ready");
        await act(async () => press(coin, type, 70));
        expect(onDrop).not.toHaveBeenCalled();
        expect(coin.dataset.motion).toBe("rest");
        expect(target.hasAttribute("data-drop")).toBe(false);
      }
    );

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
