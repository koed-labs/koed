// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  DesktopKinBridge,
  KinPresentation
} from "../../ipc/floating-kin-protocol.js";
import { useDesktopKin } from "./DesktopKin.js";

it("hands off the avatar while keeping captured Conversation controls in the sidebar", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  let change: (state: KinPresentation) => void = () => {};
  const bridge: DesktopKinBridge = {
    onPresentation: (listener) => {
      change = listener;
      return () => {};
    },
    setHomeVisible: vi.fn(),
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
    cancel: vi.fn(async () => {})
  };
  function Harness({ home }: { home: boolean }) {
    const search = useRef<HTMLInputElement>(null);
    const { showHomeAvatar, dock } = useDesktopKin(bridge, home);
    return (
      <>
        <section id="home">
          {showHomeAvatar && <span className="fk-kin-avatar" />}
        </section>
        <aside>
          <input ref={search} aria-label="Search" />
          {dock(search)}
        </aside>
      </>
    );
  }
  const transition = (
    placement: KinPresentation["placement"],
    revision = 0,
    homePending = false
  ) => act(async () => change({ placement, revision, homePending }));
  try {
    await act(async () => root.render(<Harness home />));
    expect(bridge.setHomeVisible).toHaveBeenLastCalledWith(true);
    await transition("home", 0, true);
    expect(mount.querySelector("#home .fk-kin-avatar")).toBeNull();
    await transition("home");
    expect(mount.querySelector("#home .fk-kin-avatar")).not.toBeNull();
    expect(mount.querySelector("aside .fk-kin-avatar")).toBeNull();
    await act(async () =>
      mount.querySelector<HTMLButtonElement>("aside .fk-chip")?.click()
    );
    expect(mount.querySelector("aside .fk-panel")).not.toBeNull();
    const chip = mount.querySelector<HTMLButtonElement>("aside .fk-chip")!;
    chip.focus();
    vi.mocked(bridge.activity).mockResolvedValueOnce({
      state: "running",
      conversations: [],
      overflowCount: 0
    });
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    expect(mount.querySelector("aside .fk-chip")).toBeNull();
    expect(document.activeElement).toBe(mount.querySelector("aside input"));
    await transition("home", 1);
    expect(mount.querySelector("aside .fk-panel")).toBeNull();
    await act(async () => root.render(<Harness home={false} />));
    expect(bridge.setHomeVisible).toHaveBeenLastCalledWith(false);
    await transition("sidebar", 1);
    expect(mount.querySelector("#home .fk-kin-avatar")).toBeNull();
    expect(mount.querySelector("aside .fk-kin-avatar")).not.toBeNull();
    expect(mount.querySelector("aside .fk-chip")).not.toBeNull();
    await transition("desktop", 2);
    expect(mount.querySelector(".fk-kin-avatar, .fk-chip")).toBeNull();
    expect(bridge.confirmPresentation).toHaveBeenCalledExactlyOnceWith(2);
  } finally {
    await act(async () => root.unmount());
    mount.remove();
  }
});
