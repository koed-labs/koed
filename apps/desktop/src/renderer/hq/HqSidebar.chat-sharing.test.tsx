// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@koed/shared/project-contract";
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../project-memory-ui.js";
import type { HqSidebarPreferencesApi } from "../../ipc/hq-sidebar-preferences-protocol.js";
import { HqSidebar } from "./HqSidebar.js";

const projectId = "00000000-0000-4000-8000-000000000702";
const sessionId = "00000000-0000-4000-8000-000000000703";
const stamp = "2026-10-21T12:00:00.000Z";
const project = {
  id: projectId,
  name: "Launch",
  lifecycle: "active",
  teamBackendId: "cloud-a",
  workspaceProjectId: "00000000-0000-4000-8000-000000000704"
} as Project;
const thread = {
  id: "captured-chat",
  name: "Planning chat",
  sessionId,
  originDevice: null,
  sourceAiClient: "codex",
  projectId: "technical-project",
  personalProjectId: projectId,
  projectName: "Technical project",
  projectPath: null,
  projectAssignmentSource: null,
  eventCount: 1,
  invalidatedCount: 0,
  latestAt: stamp,
  sample: "",
  presentation: null,
  threadKind: "conversation"
} as PersonalDesktopProjectThread;
const graph = [
  {
    id: "technical-project",
    name: "Technical project",
    path: null,
    threads: [thread],
    eventCount: 1,
    catalogued: false,
    discoveredAt: null,
    lastSeenAt: null,
    localProjectId: null,
    contextKind: "project",
    branch: null,
    isWorktree: false,
    remoteDisplay: null
  }
] as DesktopProject[];

describe("HQ exact chat summary controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let oldDesktop: PropertyDescriptor | undefined;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    oldDesktop = Object.getOwnPropertyDescriptor(window, "koedDesktop");
    const preferences: HqSidebarPreferencesApi = {
      get: vi.fn(async () => ({ foldedGroups: {} })),
      set: vi.fn(async (value) => value)
    };
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: { hqSidebar: preferences }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (oldDesktop) Object.defineProperty(window, "koedDesktop", oldDesktop);
    else delete window.koedDesktop;
  });
  const render = async (
    scope: string,
    status: (
      projectId: string,
      sessionId: string
    ) => Promise<"private" | "pending" | "shared" | "unshared" | "ineligible">,
    makePrivate: (
      projectId: string,
      sessionId: string
    ) => Promise<{ state: "private" }>,
    boundProject: Project = project,
    shareAgain?: (
      projectId: string,
      sessionId: string
    ) => Promise<{ state: "pending" | "activated" | "canceled" }>,
    shareUnshared?: (
      projectId: string,
      sessionId: string
    ) => Promise<{ state: "pending" | "activated" | "canceled" }>,
    shownProjects: readonly DesktopProject[] = graph,
    sharedAudienceNames: Readonly<Record<string, readonly string[]>> = {}
  ) => {
    await act(async () =>
      root.render(
        <HqSidebar
          chatShareScopeKey={scope}
          onChatShareStatus={status}
          onMakeChatPrivate={makePrivate}
          onShareChatAgain={shareAgain}
          onShareUnsharedChat={shareUnshared}
          sharedAudienceNames={sharedAudienceNames}
          onOpenSearchAndCommands={() => undefined}
          onSelectConversation={() => undefined}
          onSelectProject={() => undefined}
          personalProjects={[boundProject]}
          projects={shownProjects}
          route={{ kind: "home" }}
        />
      )
    );
  };
  const openMenu = async () => {
    const row = container.querySelector(".hq-sidebar__conversation")!;
    await act(async () =>
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
      )
    );
  };
  const action = (name: string) =>
    [
      ...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")
    ].find((button) => button.textContent === name);

  it("announces the exact member only after an activated summary receipt", async () => {
    const offer = vi.fn().mockResolvedValue({ state: "activated" });
    await render(
      "owner:profile",
      vi.fn().mockResolvedValue("unshared"),
      vi.fn(),
      project,
      undefined,
      offer,
      graph,
      { [projectId]: ["Mark"] }
    );
    await openMenu();
    expect(container.textContent).not.toContain("Summary shared with Mark.");
    await act(async () => action("Share a summary")!.click());
    expect(offer).toHaveBeenCalledExactlyOnceWith(projectId, sessionId);
    expect(container.querySelector(".hq-project-toast")?.textContent).toContain(
      "Summary shared with Mark."
    );
  });

  it("offers Make private only after exact status and never claims private on cancellation", async () => {
    const status = vi.fn().mockResolvedValue("shared");
    const makePrivate = vi
      .fn()
      .mockRejectedValueOnce(new Error("Project summary sharing was canceled."))
      .mockResolvedValueOnce({ state: "private" });
    await render("owner:profile", status, makePrivate);
    await openMenu();
    expect(status).toHaveBeenCalledExactlyOnceWith(projectId, sessionId);
    expect(action("Make private")).toBeDefined();
    await act(async () => action("Make private")!.click());
    expect(container.textContent).toContain(
      "Project summary sharing was canceled."
    );
    expect(container.textContent).not.toContain("This chat is private.");
    expect(
      container.querySelector('[aria-label="Chat summary private"]')
    ).toBeNull();
    expect(action("Make private")).toBeUndefined();
    await act(async () => action("Check summary status again")!.click());
    expect(status).toHaveBeenCalledTimes(2);
    await act(async () => action("Make private")!.click());
    expect(makePrivate).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("This chat is private.");
    expect(
      container.querySelector('[aria-label="Chat summary private"]')
    ).not.toBeNull();
    expect(action("Make private")).toBeUndefined();
    expect(action("Share again")).toBeUndefined();
  });

  it("allows a pending summary to be made private but hides controls after scope changes", async () => {
    let resolveOld!: (value: "shared") => void;
    const oldStatus = vi.fn().mockReturnValue(
      new Promise<"shared">((resolve) => {
        resolveOld = resolve;
      })
    );
    const makePrivate = vi.fn().mockResolvedValue({ state: "private" });
    await render("old-owner:profile", oldStatus, makePrivate);
    await openMenu();
    const newStatus = vi.fn().mockResolvedValue("pending");
    await render("new-owner:profile", newStatus, makePrivate);
    await openMenu();
    await act(async () => resolveOld("shared"));
    expect(newStatus).toHaveBeenCalledExactlyOnceWith(projectId, sessionId);
    expect(action("Make private")).toBeDefined();
    expect(action("Share again")).toBeUndefined();
    await act(async () => action("Make private")!.click());
    expect(makePrivate).toHaveBeenCalledExactlyOnceWith(projectId, sessionId);
  });

  it("does not read summary status for an unlinked Project", async () => {
    const status = vi.fn();
    const makePrivate = vi.fn();
    await render("owner:profile", status, makePrivate, {
      ...project,
      workspaceProjectId: null,
      teamBackendId: null
    } as Project);
    await openMenu();
    expect(status).not.toHaveBeenCalled();
    expect(action("Make private")).toBeUndefined();
  });

  it("does not offer sharing controls for an authoritatively ineligible HQ chat", async () => {
    const status = vi.fn().mockResolvedValue("ineligible");
    const makePrivate = vi.fn();
    await render("owner:profile", status, makePrivate);
    await openMenu();
    expect(status).toHaveBeenCalledExactlyOnceWith(projectId, sessionId);
    expect(action("Make private")).toBeUndefined();
    expect(action("Share again")).toBeUndefined();
    expect(
      container.querySelector('[aria-label="Chat summary private"]')
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Chat summary sharing"]')
    ).toBeNull();
    expect(makePrivate).not.toHaveBeenCalled();
  });

  it("offers a fresh Native Share again only for a confirmed private chat", async () => {
    const status = vi.fn().mockResolvedValue("private");
    const makePrivate = vi.fn();
    const shareAgain = vi
      .fn()
      .mockResolvedValueOnce({ state: "canceled" })
      .mockResolvedValueOnce({ state: "pending" });
    await render("owner:profile", status, makePrivate, project, shareAgain);
    await openMenu();
    expect(action("Share again")).toBeDefined();
    await act(async () => action("Share again")!.click());
    expect(shareAgain).toHaveBeenCalledExactlyOnceWith(projectId, sessionId);
    expect(container.textContent).toContain("This chat remains private.");
    expect(
      container.querySelector('[aria-label="Chat summary private"]')
    ).not.toBeNull();
    await act(async () => action("Share again")!.click());
    expect(container.textContent).toContain("Summary sharing is pending.");
    expect(action("Share again")).toBeUndefined();
    expect(action("Make private")).toBeDefined();
    expect(
      container.querySelector('[aria-label="Chat summary private"]')
    ).toBeNull();
  });

  it("never offers Share again from an unshared or unknown status", async () => {
    const status = vi.fn().mockResolvedValue("unshared");
    const shareAgain = vi.fn();
    await render("owner:profile", status, vi.fn(), project, shareAgain);
    await openMenu();
    expect(action("Share again")).toBeUndefined();
    expect(shareAgain).not.toHaveBeenCalled();
    await render(
      "owner:profile:changed",
      vi.fn().mockRejectedValue(new Error("Status unavailable")),
      vi.fn(),
      project,
      shareAgain
    );
    await openMenu();
    expect(container.textContent).toContain("Status unavailable");
    expect(action("Share again")).toBeUndefined();
    expect(shareAgain).not.toHaveBeenCalled();
  });

  it("lets an eligible unshared chat retry an explicitly reviewed summary after declining", async () => {
    const status = vi.fn().mockResolvedValue("unshared");
    const offer = vi
      .fn()
      .mockResolvedValueOnce({ state: "canceled" })
      .mockResolvedValueOnce({ state: "pending" });
    await render("owner:profile", status, vi.fn(), project, undefined, offer);
    await openMenu();
    expect(action("Share a summary")).toBeDefined();
    expect(action("Share again")).toBeUndefined();
    await act(async () => action("Share a summary")!.click());
    expect(offer).toHaveBeenCalledExactlyOnceWith(projectId, sessionId);
    expect(container.textContent).toContain("summary remains unshared");
    expect(action("Share a summary")).toBeDefined();
    await act(async () => action("Share a summary")!.click());
    expect(offer).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Summary sharing is pending.");
    expect(action("Share a summary")).toBeUndefined();
    expect(action("Make private")).toBeDefined();
  });

  it("discards a late Share again receipt after the owner scope changes", async () => {
    let resolveOld!: (value: { state: "activated" }) => void;
    const oldOffer = vi.fn().mockReturnValue(
      new Promise<{ state: "activated" }>((resolve) => {
        resolveOld = resolve;
      })
    );
    await render(
      "old-owner:profile",
      vi.fn().mockResolvedValue("private"),
      vi.fn(),
      project,
      oldOffer
    );
    await openMenu();
    await act(async () => action("Share again")!.click());
    await render(
      "new-owner:profile",
      vi.fn().mockResolvedValue("unshared"),
      vi.fn(),
      project,
      undefined,
      vi.fn().mockResolvedValue({ state: "pending" })
    );
    await openMenu();
    await act(async () => resolveOld({ state: "activated" }));
    expect(action("Share again")).toBeUndefined();
    expect(action("Share a summary")).toBeDefined();
    expect(action("Make private")).toBeUndefined();
    expect(container.textContent).toContain("summary is not shared");
  });

  it("keeps a confirmed private badge while reviewing a second chat in the same Project", async () => {
    const otherSessionId = "00000000-0000-4000-8000-000000000705";
    const otherThread = {
      ...thread,
      id: "other-captured-chat",
      sessionId: otherSessionId,
      name: "Other chat"
    } as PersonalDesktopProjectThread;
    const twoChatGraph = [
      { ...graph[0]!, threads: [thread, otherThread] }
    ] as DesktopProject[];
    const status = vi.fn(async (_projectId: string, selectedId: string) =>
      selectedId === sessionId ? ("private" as const) : ("shared" as const)
    );
    await render(
      "owner:profile",
      status,
      vi.fn(),
      project,
      undefined,
      undefined,
      twoChatGraph
    );
    await openMenu();
    expect(
      container.querySelectorAll('[aria-label="Chat summary private"]')
    ).toHaveLength(1);
    const second = [
      ...container.querySelectorAll(".hq-sidebar__conversation")
    ].find((row) => row.textContent?.includes("Other chat"));
    await act(async () =>
      second!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
      )
    );
    expect(status).toHaveBeenCalledWith(projectId, otherSessionId);
    expect(action("Make private")).toBeDefined();
    expect(
      container.querySelectorAll('[aria-label="Chat summary private"]')
    ).toHaveLength(1);
  });
});
