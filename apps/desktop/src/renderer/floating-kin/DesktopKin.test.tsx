// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  DesktopKinBridge,
  KinPresentation
} from "../../ipc/floating-kin-protocol.js";
import { NavigationShell } from "../v1/NavigationShell.js";
import type { SidebarProject } from "../v1/project-sidebar-model.js";
import { useDesktopKin } from "./DesktopKin.js";

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
        kinActivity={kin.activity}
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
    expect(marker()).toBeNull();
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
    await transition("desktop", 2);
    expect(
      mount.querySelector(".fk-rail-kin, .fk-row-live, .fk-chip")
    ).toBeNull();
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

it("counts only Conversations captured within the minute as active", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const fresh = "00000000-0000-4000-8000-000000000001";
  const older = "00000000-0000-4000-8000-000000000002";
  const capture = (sessionId: string, ageMs: number) => ({
    sessionId,
    client: "codex" as const,
    lastActivityAt: new Date(Date.now() - ageMs).toISOString(),
    projectId: null
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
      conversations: [capture(fresh, 5_000), capture(older, 5 * 60_000)]
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
        kinActivity={kin.activity}
      >
        home
      </NavigationShell>
    );
  }
  try {
    await act(async () => root.render(<Harness />));
    await vi.waitFor(() =>
      expect(mount.querySelector(".fk-live-status")?.textContent).toBe(
        "1 active"
      )
    );
    const recent = [
      ...mount.querySelectorAll<HTMLElement>(
        '.v1-nav-rail .fk-chip .fk-dot[data-recent="true"]'
      )
    ];
    expect(recent).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});
