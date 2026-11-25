// @vitest-environment happy-dom
import { act, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  DesktopKinBridge,
  KinPresentation
} from "../../ipc/floating-kin-protocol.js";
import { NavigationShell } from "../v1/NavigationShell.js";
import type { SidebarProject } from "../v1/project-sidebar-model.js";
import { fitPanelTop, useDesktopKin } from "./DesktopKin.js";

it("puts the live Kin on the Home button and opens summaries from Conversation rows", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  let change: (state: KinPresentation) => void = () => {};
  let showAiModels: () => void = () => {};
  let showConversation: (sessionId: string) => void = () => {};
  const openAiModels = vi.fn();
  const openConversation = vi.fn((_sessionId: string) => true);
  const bridge: DesktopKinBridge = {
    onPresentation: (listener) => {
      change = listener;
      return () => {};
    },
    setShellVisible: vi.fn(),
    onOpenAiModels: (listener) => {
      showAiModels = listener;
      return () => {};
    },
    onOpenConversation: (listener) => {
      showConversation = listener;
      return () => {};
    },
    confirmPresentation: vi.fn(),
    activity: vi.fn<DesktopKinBridge["activity"]>(async () => ({
      state: "running",
      overflowCount: 0,
      conversations: [
        {
          sessionId: "00000000-0000-4000-8000-000000000001",
          client: "codex",
          lastActivityAt: new Date().toISOString(),
          projectId: null
        }
      ]
    })),
    summarize: vi.fn<DesktopKinBridge["summarize"]>(async () => ({
      status: "unavailable"
    })),
    preview: vi.fn(async () => null),
    latest: vi.fn(async () => ({ action: null })),
    reopen: vi.fn(async () => null),
    cancel: vi.fn(async () => {})
  };
  const noop = () => {};
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const projects: SidebarProject[] = [
    {
      id: "project",
      name: "Koed",
      latestAt: new Date().toISOString(),
      conversations: [
        {
          key: `session:${sessionId}`,
          aliases: [`session:${sessionId}`],
          title: "Tracked Conversation",
          client: "codex",
          latestAt: new Date().toISOString(),
          sessionId,
          route: { kind: "conversation", projectId: "project", threadId: "t" },
          projectName: "Koed"
        }
      ]
    }
  ];
  function Harness({ route }: { route: "home" | "recall" }) {
    const kin = useDesktopKin(
      bridge,
      null,
      true,
      openAiModels,
      openConversation
    );
    return (
      <NavigationShell
        projects={projects}
        route={{ kind: route }}
        scopeKey={null}
        onSelect={noop}
        onHome={noop}
        onSettings={noop}
        onBack={noop}
        onForward={noop}
        canGoBack={false}
        canGoForward={false}
        onRetry={noop}
        kinAvatar={kin.avatar}
        kinLive={kin.live}
        kinPanel={kin.panel}
        kinChips={kin.chips}
      >
        {route}
      </NavigationShell>
    );
  }
  const transition = (
    placement: KinPresentation["placement"],
    revision = 0,
    sidebarPending = false
  ) => act(async () => change({ placement, revision, sidebarPending }));
  const home = () =>
    mount.querySelector<HTMLButtonElement>('[aria-label="Koed, home"]')!;
  const avatar = () => home().querySelector(".fk-rail-kin");
  const marker = () =>
    mount.querySelector<HTMLButtonElement>(".v1-nav-projects .fk-row-live");
  const chip = () =>
    mount.querySelector<HTMLButtonElement>(".v1-nav-rail .fk-chip");
  const panel = () =>
    document.querySelector('[data-fk-placement="anchored"] .fk-panel');
  try {
    await act(async () => root.render(<Harness route="home" />));
    expect(bridge.setShellVisible).toHaveBeenCalledExactlyOnceWith(true);
    await transition("sidebar", 0, true);
    expect(avatar()).toBeNull();
    expect(home().querySelector(".v1-logo")).not.toBeNull();
    // Chips stay in the rail while the floating Kin is still leaving.
    await vi.waitFor(() => expect(chip()).not.toBeNull());
    await transition("sidebar");
    expect(
      avatar()?.querySelector(
        '[data-kin-shape="roundedBox"][data-kin-colour="#3083ff"][data-kin-gradient="true"]'
      )
    ).not.toBeNull();
    expect(home().querySelector(".v1-logo")).toBeNull();
    expect(chip()?.getAttribute("aria-label")).toMatch(/^Codex Conversation 1/);
    expect(
      home().compareDocumentPosition(chip()!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const railAvatar = avatar();
    await act(async () => root.render(<Harness route="recall" />));
    expect(avatar()).toBe(railAvatar);
    expect(bridge.setShellVisible).toHaveBeenCalledExactlyOnceWith(true);
    const toggle = mount.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle navigation"]'
    )!;
    await act(async () => toggle.click());
    expect(mount.querySelectorAll(".fk-rail-kin")).toHaveLength(1);
    await act(async () => chip()!.click());
    expect(chip()?.getAttribute("aria-expanded")).toBe("true");
    expect(panel()).not.toBeNull();
    await act(async () => chip()!.click());
    expect(panel()).toBeNull();
    await act(async () => toggle.click());
    expect(marker()?.closest("li")?.textContent).toContain(
      "Tracked Conversation"
    );
    await act(async () => marker()!.click());
    expect(marker()?.getAttribute("aria-expanded")).toBe("true");
    expect(panel()).not.toBeNull();
    panel()
      ?.querySelector<HTMLButtonElement>(
        'button[aria-label="AI models settings"]'
      )
      ?.focus();
    await act(async () => toggle.click());
    expect(panel()).toBeNull();
    expect(chip()?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(
      mount.querySelector(".v1-navigation-main")
    );
    await act(async () => chip()!.click());
    expect(panel()).not.toBeNull();
    await act(async () => toggle.click());
    expect(panel()).not.toBeNull();
    await act(async () => toggle.click());
    expect(panel()).not.toBeNull();
    await act(async () => toggle.click());
    const settings = document.querySelector<HTMLButtonElement>(
      'button[aria-label="AI models settings"]'
    )!;
    await act(async () => settings.click());
    expect(openAiModels).toHaveBeenCalledTimes(1);
    const title = document.querySelector<HTMLButtonElement>(".fk-title-link")!;
    await act(async () => title.click());
    expect(openConversation).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(panel()).toBeNull();
    await act(async () => marker()!.click());
    const reopened = document.querySelector<HTMLButtonElement>(
      'button[aria-label="AI models settings"]'
    )!;
    reopened.focus();
    vi.mocked(bridge.activity).mockResolvedValueOnce({
      state: "running",
      conversations: [],
      overflowCount: 0
    });
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    expect(marker()).toBeNull();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(mount.querySelector("input"));
    await transition("sidebar", 1);
    expect(panel()).toBeNull();
    expect(avatar()).not.toBeNull();
    expect(marker()).not.toBeNull();
    // The Kin floats, but its chips and row markers stay in Desktop, even
    // before the new revision's first activity read returns.
    vi.mocked(bridge.activity).mockReturnValueOnce(new Promise(() => {}));
    await transition("desktop", 2);
    expect(mount.querySelector(".fk-rail-kin")).toBeNull();
    expect(chip()).not.toBeNull();
    expect(marker()).not.toBeNull();
    expect(bridge.confirmPresentation).toHaveBeenCalledExactlyOnceWith(2);
    await act(async () => showAiModels());
    expect(openAiModels).toHaveBeenCalledTimes(2);
    await act(async () => showConversation("session-from-overlay"));
    expect(openConversation).toHaveBeenLastCalledWith("session-from-overlay");
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});

it("opens a Conversation requested while Desktop is still loading once its row appears", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  let showConversation: (sessionId: string) => void = () => {};
  const bridge = {
    onPresentation: (listener: (state: KinPresentation) => void) => {
      listener({ placement: "sidebar", revision: 0 });
      return () => {};
    },
    setShellVisible: vi.fn(),
    onOpenAiModels: () => () => {},
    onOpenConversation: (listener: (sessionId: string) => void) => {
      showConversation = listener;
      return () => {};
    },
    confirmPresentation: vi.fn(),
    activity: vi.fn(async () => ({
      state: "running" as const,
      overflowCount: 0,
      conversations: []
    })),
    summarize: vi.fn(async () => ({ status: "unavailable" as const })),
    preview: vi.fn(async () => null),
    latest: vi.fn(async () => ({ action: null })),
    reopen: vi.fn(async () => null),
    cancel: vi.fn(async () => {})
  } as unknown as DesktopKinBridge;
  const opened: string[] = [];
  function Harness({ rows }: { rows: string[] }) {
    const open = useCallback(
      (sessionId: string) => {
        if (!rows.includes(sessionId)) return false;
        opened.push(sessionId);
        return true;
      },
      [rows]
    );
    useDesktopKin(bridge, null, true, undefined, open);
    return null;
  }
  try {
    await act(async () => root.render(<Harness rows={[]} />));
    await act(async () => showConversation("loading-session"));
    expect(opened).toEqual([]);
    await act(async () => root.render(<Harness rows={["other"]} />));
    expect(opened).toEqual([]);
    await act(async () =>
      root.render(<Harness rows={["other", "loading-session"]} />)
    );
    expect(opened).toEqual(["loading-session"]);
    await act(async () =>
      root.render(<Harness rows={["loading-session", "again"]} />)
    );
    expect(opened).toEqual(["loading-session"]);
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});

it("shows the live dot for an active turn and the capture age otherwise", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const fresh = "00000000-0000-4000-8000-000000000001";
  const older = "00000000-0000-4000-8000-000000000002";
  const busy = "00000000-0000-4000-8000-000000000003";
  const capture = (
    sessionId: string,
    ageMs: number,
    turn?: "active" | "idle"
  ) => ({
    sessionId,
    client: "codex" as const,
    lastActivityAt: new Date(Date.now() - ageMs).toISOString(),
    projectId: null,
    ...(turn ? { turn } : {})
  });
  const bridge: DesktopKinBridge = {
    onPresentation: (listener) => {
      listener({ placement: "sidebar", revision: 0 });
      return () => {};
    },
    setShellVisible: vi.fn(),
    onOpenAiModels: () => () => {},
    onOpenConversation: () => () => {},
    confirmPresentation: vi.fn(),
    activity: vi.fn<DesktopKinBridge["activity"]>(async () => ({
      state: "running",
      overflowCount: 0,
      conversations: [
        capture(fresh, 5_000, "idle"),
        capture(busy, 2 * 60_000, "active"),
        capture(older, 5 * 60_000)
      ]
    })),
    summarize: vi.fn<DesktopKinBridge["summarize"]>(async () => ({
      status: "unavailable"
    })),
    preview: vi.fn(async () => null),
    latest: vi.fn(async () => ({ action: null })),
    reopen: vi.fn(async () => null),
    cancel: vi.fn(async () => {})
  };
  const row = (sessionId: string, title: string) => ({
    key: `session:${sessionId}`,
    aliases: [`session:${sessionId}`],
    title,
    client: "codex" as const,
    latestAt: new Date().toISOString(),
    sessionId,
    route: {
      kind: "conversation" as const,
      projectId: "project",
      threadId: sessionId
    },
    projectName: "Koed"
  });
  const projects: SidebarProject[] = [
    {
      id: "project",
      name: "Koed",
      latestAt: new Date().toISOString(),
      conversations: [
        row(fresh, "Fresh"),
        row(older, "Older"),
        // A combined row whose active session isn't its representative one.
        {
          ...row("00000000-0000-4000-8000-0000000000aa", "Combined"),
          sourceSessionIds: ["00000000-0000-4000-8000-0000000000aa", busy]
        }
      ]
    }
  ];
  const noop = () => {};
  function Harness() {
    const kin = useDesktopKin(bridge, null, true);
    return (
      <NavigationShell
        projects={projects}
        route={{ kind: "home" }}
        scopeKey={null}
        onSelect={noop}
        onHome={noop}
        onSettings={noop}
        onBack={noop}
        onForward={noop}
        canGoBack={false}
        canGoForward={false}
        onRetry={noop}
        kinAvatar={kin.avatar}
        kinLive={kin.live}
        kinPanel={kin.panel}
        kinChips={kin.chips}
      >
        home
      </NavigationShell>
    );
  }
  try {
    await act(async () => root.render(<Harness />));
    await vi.waitFor(() =>
      expect(mount.querySelector(".v1-nav-rail .fk-chip")).not.toBeNull()
    );
    expect(mount.querySelector(".fk-live-status")).toBeNull();
    const labels = [
      ...mount.querySelectorAll<HTMLElement>(".v1-nav-rail .fk-chip-label")
    ];
    expect(labels.map((label) => label.textContent)).toEqual(["5s", "", "5m"]);
    expect(
      labels.map((label) => label.querySelector(".fk-dot") !== null)
    ).toEqual([false, true, false]);
    const markerFor = (title: string) =>
      [...mount.querySelectorAll<HTMLElement>(".fk-row-live")].find((marker) =>
        marker.getAttribute("aria-label")?.includes(title)
      );
    const combined = markerFor("Combined");
    expect(combined).toBeDefined();
    expect(combined!.querySelector(".fk-dot")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});

it("uses only an unexpired Pi report, and expires it while the Kin floats", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const fresh = "00000000-0000-4000-8000-000000000001";
  const older = "00000000-0000-4000-8000-000000000002";
  const busy = "00000000-0000-4000-8000-000000000003";
  const capture = (
    sessionId: string,
    ageMs: number,
    turn?: "active" | "idle"
  ) => ({
    sessionId,
    client: "pi" as const,
    lastActivityAt: new Date(Date.now() - ageMs).toISOString(),
    projectId: null,
    ...(turn ? { turn } : {})
  });
  const bridge: DesktopKinBridge = {
    onPresentation: (listener) => {
      listener({ placement: "desktop", revision: 0 });
      return () => {};
    },
    setShellVisible: vi.fn(),
    onOpenAiModels: () => () => {},
    onOpenConversation: () => () => {},
    confirmPresentation: vi.fn(),
    activity: vi.fn<DesktopKinBridge["activity"]>(async () => ({
      state: "running",
      overflowCount: 0,
      conversations: [
        // A guessed turn alone never shows Pi as working.
        capture(fresh, 5_000, "active"),
        {
          ...capture(busy, 2 * 60_000),
          workingUntil: new Date(Date.now() + 400).toISOString()
        }
      ]
    })),
    summarize: vi.fn<DesktopKinBridge["summarize"]>(async () => ({
      status: "unavailable"
    })),
    preview: vi.fn(async () => null),
    latest: vi.fn(async () => ({ action: null })),
    reopen: vi.fn(async () => null),
    cancel: vi.fn(async () => {})
  };
  const row = (sessionId: string, title: string) => ({
    key: `session:${sessionId}`,
    aliases: [`session:${sessionId}`],
    title,
    client: "codex" as const,
    latestAt: new Date().toISOString(),
    sessionId,
    route: {
      kind: "conversation" as const,
      projectId: "project",
      threadId: sessionId
    },
    projectName: "Koed"
  });
  const projects: SidebarProject[] = [
    {
      id: "project",
      name: "Koed",
      latestAt: new Date().toISOString(),
      conversations: [row(fresh, "Fresh"), row(older, "Older")]
    }
  ];
  const noop = () => {};
  function Harness() {
    const kin = useDesktopKin(bridge, null, true);
    return (
      <NavigationShell
        projects={projects}
        route={{ kind: "home" }}
        scopeKey={null}
        onSelect={noop}
        onHome={noop}
        onSettings={noop}
        onBack={noop}
        onForward={noop}
        canGoBack={false}
        canGoForward={false}
        onRetry={noop}
        kinAvatar={kin.avatar}
        kinLive={kin.live}
        kinPanel={kin.panel}
        kinChips={kin.chips}
      >
        home
      </NavigationShell>
    );
  }
  try {
    await act(async () => root.render(<Harness />));
    await vi.waitFor(() =>
      expect(mount.querySelector(".v1-nav-rail .fk-chip")).not.toBeNull()
    );
    const dots = () =>
      [
        ...mount.querySelectorAll<HTMLElement>(".v1-nav-rail .fk-chip-label")
      ].map((label) => label.querySelector(".fk-dot") !== null);
    expect(dots()).toEqual([false, true]);
    // No new activity read lands, but the lease still expires.
    vi.mocked(bridge.activity).mockReturnValue(new Promise(() => {}));
    await vi.waitFor(() => expect(dots()).toEqual([false, false]), {
      timeout: 2_000
    });
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});

it("moves a panel opened near the bottom up so its actions stay in the window", () => {
  // A 640px window, a row near the bottom and a 300px panel.
  expect(fitPanelTop(560, 300, 640)).toBe(332);
  // Room below: the panel stays level with its row.
  expect(fitPanelTop(120, 300, 640)).toBe(120);
  // Taller than the window: pinned to the top margin and scrolled inside.
  expect(fitPanelTop(560, 900, 640)).toBe(8);
});
