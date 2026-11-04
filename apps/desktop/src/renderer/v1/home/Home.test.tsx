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
    expect(container.querySelector(".v1-home-keycaps")).not.toBeNull();
    expect(
      container.querySelector(".v1-home-stage .v1-home-caption")
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
    // The "?" help button sits between the skipped count and last activity.
    expect(container.textContent).toContain("3 completed · 1 skipped");
    expect(container.textContent).toContain("Last activity 1m ago");
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.hasAttribute("data-indeterminate")).toBe(true);
    expect(
      container.querySelector('button[aria-label="Open Project koed"]')
    ).not.toBeNull();
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
});
