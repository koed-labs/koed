// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, teamDiscIndex } from "./AppShell.js";

describe("AppShell", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const renderShell = async (
    overrides: Partial<ComponentProps<typeof AppShell>> = {}
  ) => {
    const props: ComponentProps<typeof AppShell> = {
      activeScope: "personal",
      children: <div>Route body</div>,
      contextNavigation: <div>Personal navigation</div>,
      identityLabel: "Personal",
      inspector: <div>Details</div>,
      inspectorOpen: false,
      canGoBack: false,
      canGoForward: false,
      onActivateInbox: vi.fn(),
      onActivatePersonal: vi.fn(),
      onActivateTeam: vi.fn(),
      onAddTeam: vi.fn(),
      onCloseInspector: vi.fn(),
      onGoBack: vi.fn(),
      onGoForward: vi.fn(),
      onOpenHealth: vi.fn(),
      onOpenCommandPalette: vi.fn(),
      onOpenDevices: vi.fn(),
      onOpenPreferences: vi.fn(),
      onToggleInspector: vi.fn(),
      personalUnreadCount: 3,
      scopeLine: <span>Personal · Private to you</span>,
      routeFocusKey: "/personal",
      teams: [
        {
          connectionState: "healthy",
          id: "team-a",
          name: "Alpha Team",
          unreadCount: 4
        }
      ],
      ...overrides
    };
    await act(async () => root.render(<AppShell {...props} />));
    return props;
  };

  it("presents Inbox, Personal, Teams, Add Team, and Preferences", async () => {
    await renderShell();
    expect(
      [...container.querySelectorAll("button")].map((item) =>
        item.getAttribute("aria-label")
      )
    ).toEqual(
      expect.arrayContaining([
        "Inbox",
        "Personal",
        "Alpha Team",
        "Devices",
        "Add or join Team",
        "Search and commands",
        "Preferences"
      ])
    );
    expect(container.textContent).toContain("4");
    expect(
      container.querySelector('[aria-label="Personal"] [aria-label="3 unread"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Personal"] > svg')
    ).not.toBeNull();
    expect(container.querySelector(".desktop-personal-mark")).toBeNull();
    expect(container.textContent).toContain("Personal · Private to you");
    expect(
      [
        ...container.querySelectorAll(
          ".desktop-rail-bottom > .desktop-rail-button"
        )
      ].map((item) => item.getAttribute("aria-label"))
    ).toEqual([
      "Search and commands",
      "Add or join Team",
      "Devices",
      "Preferences"
    ]);
  });

  it("marks the selected Team as the active rail scope", async () => {
    await renderShell({ activeScope: { teamId: "team-a" } });
    const team = container.querySelector<HTMLButtonElement>(
      '.desktop-team-rail [aria-label="Alpha Team"]'
    );
    expect(team?.dataset.active).toBe("true");
    expect(team?.getAttribute("aria-current")).toBe("page");
  });

  it("routes keyboard commands to the owning shell", async () => {
    const props = await renderShell({
      canGoBack: true,
      canGoForward: true
    });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { ctrlKey: true, key: "k" })
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", { ctrlKey: true, key: "," })
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          ctrlKey: true,
          shiftKey: true,
          key: "i"
        })
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", { altKey: true, key: "ArrowLeft" })
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", { altKey: true, key: "ArrowRight" })
      );
    });
    expect(props.onOpenCommandPalette).toHaveBeenCalledOnce();
    expect(props.onOpenPreferences).toHaveBeenCalledOnce();
    expect(props.onToggleInspector).toHaveBeenCalledOnce();
    expect(props.onGoBack).toHaveBeenCalledOnce();
    expect(props.onGoForward).toHaveBeenCalledOnce();
  });

  it("uses stable generated Team swatches", () => {
    expect(teamDiscIndex("team-a")).toBe(teamDiscIndex("team-a"));
    expect(teamDiscIndex("team-a")).toBeGreaterThanOrEqual(0);
    expect(teamDiscIndex("team-a")).toBeLessThan(8);
  });

  it("shows starting, healthy, and immediate attention health states", async () => {
    await renderShell({
      health: { label: "Koed is starting", state: "starting" }
    });
    expect(
      container.querySelector('.desktop-health-trigger[data-state="starting"]')
    ).not.toBeNull();
    expect(container.querySelector(".lucide-loader-circle")).not.toBeNull();

    await renderShell({
      health: { label: "Koed is ready", state: "healthy" }
    });
    expect(container.querySelector(".lucide-circle-check")).not.toBeNull();

    await renderShell({
      health: { label: "2 services need attention", state: "needs_attention" }
    });
    expect(container.querySelector(".lucide-circle-alert")).not.toBeNull();
  });

  it("replaces an unready spinner with an error after 45 seconds", async () => {
    vi.useFakeTimers();
    await renderShell({
      health: { label: "Koed is starting", state: "starting" }
    });

    await act(async () => vi.advanceTimersByTime(44_999));
    expect(container.querySelector(".lucide-loader-circle")).not.toBeNull();

    await act(async () => vi.advanceTimersByTime(1));
    expect(container.querySelector(".lucide-circle-alert")).not.toBeNull();
    expect(
      container
        .querySelector('[data-state="needs_attention"]')
        ?.getAttribute("aria-label")
    ).toBe("Local health: Koed did not become ready within 45 seconds");
  });

  it("uses one roving tab stop and supports Team rail navigation", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    await renderShell({
      teams: [
        { id: "team-a", name: "Alpha", unreadCount: 0 },
        { id: "team-b", name: "Beta", unreadCount: 0 },
        { id: "team-c", name: "Gamma", unreadCount: 0 }
      ]
    });
    const teams = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".desktop-team-rail .desktop-rail-button"
      )
    ];
    expect(teams.map(({ tabIndex }) => tabIndex)).toEqual([0, -1, -1]);

    await act(async () => {
      teams[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "End" })
      );
    });
    expect(document.activeElement).toBe(teams[2]);
    expect(teams.map(({ tabIndex }) => tabIndex)).toEqual([-1, -1, 0]);
  });
});
