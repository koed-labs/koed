// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  DesktopKinBridge,
  KinPresentation
} from "../../ipc/floating-kin-protocol.js";
import { NavigationShell } from "../v1/NavigationShell.js";
import { useDesktopKin } from "./DesktopKin.js";

it("hands off the avatar while keeping captured Conversation controls in the sidebar", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  let change: (state: KinPresentation) => void = () => {};
  let showAiModels: () => void = () => {};
  const openAiModels = vi.fn();
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
  function Harness({ route }: { route: "home" | "recall" }) {
    const { dock, avatar } = useDesktopKin(bridge, null, true, openAiModels);
    return (
      <NavigationShell
        projects={[]}
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
        kinDock={dock}
        kinAvatar={avatar}
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
  try {
    await act(async () => root.render(<Harness route="home" />));
    expect(bridge.setShellVisible).toHaveBeenCalledExactlyOnceWith(true);
    await transition("sidebar", 0, true);
    const projects = mount.querySelector(
      '[aria-label="Conversations and Projects"]'
    )!;
    const avatar = () =>
      projects.querySelector(".fk-sidebar-avatar .fk-kin-avatar");
    expect(avatar()).toBeNull();
    expect(projects.querySelector(".fk-chip")).toBeNull();
    await transition("sidebar");
    expect(
      avatar()?.querySelector(
        '[data-kin-shape="roundedBox"][data-kin-colour="#3083ff"][data-kin-gradient="true"]'
      )
    ).not.toBeNull();
    const dockedAvatar = avatar();
    await act(async () => root.render(<Harness route="recall" />));
    expect(avatar()).toBe(dockedAvatar);
    expect(bridge.setShellVisible).toHaveBeenCalledExactlyOnceWith(true);
    const toggle = mount.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle navigation"]'
    )!;
    await act(async () => toggle.click());
    expect(avatar()).toBeNull();
    expect(mount.querySelectorAll(".fk-kin-avatar")).toHaveLength(1);
    expect(
      mount.querySelector(".v1-nav-rail .fk-sidebar-avatar[data-collapsed]")
    ).not.toBeNull();
    await act(async () => toggle.click());
    expect(avatar()).not.toBeNull();
    const chip = projects.querySelector<HTMLButtonElement>(".fk-chip")!;
    expect(avatar()?.parentElement?.nextElementSibling?.contains(chip)).toBe(
      true
    );
    await act(async () => chip.click());
    expect(projects.querySelector(".fk-panel")).not.toBeNull();
    const settings = projects.querySelector<HTMLButtonElement>(
      'button[aria-label="AI models settings"]'
    )!;
    await act(async () => settings.click());
    expect(openAiModels).toHaveBeenCalledTimes(1);
    chip.focus();
    vi.mocked(bridge.activity).mockResolvedValueOnce({
      state: "running",
      conversations: [],
      overflowCount: 0
    });
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    expect(projects.querySelector(".fk-chip")).toBeNull();
    expect(document.activeElement).toBe(projects.querySelector("input"));
    await transition("sidebar", 1);
    expect(projects.querySelector(".fk-panel")).toBeNull();
    expect(avatar()).not.toBeNull();
    expect(projects.querySelector(".fk-chip")).not.toBeNull();
    await transition("desktop", 2);
    expect(mount.querySelector(".fk-kin-avatar, .fk-chip")).toBeNull();
    expect(bridge.confirmPresentation).toHaveBeenCalledExactlyOnceWith(2);
    await act(async () => showAiModels());
    expect(openAiModels).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});
