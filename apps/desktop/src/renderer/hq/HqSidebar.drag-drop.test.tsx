// @vitest-environment happy-dom

import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import type { Project } from "@koed/shared/project-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HqSidebarPreferencesApi } from "../../ipc/hq-sidebar-preferences-protocol.js";
import type { DesktopProject } from "../../project-memory-ui.js";
import { HqSidebar } from "./HqSidebar.js";

const projectA = "00000000-0000-4000-8000-0000000000a1";
const projectB = "00000000-0000-4000-8000-0000000000b2";
const looseSession = "00000000-0000-4000-8000-000000000101";
const projectSession = "00000000-0000-4000-8000-000000000102";
const mime = "application/x-koed-conversation";
const now = "2026-10-20T12:00:00.000Z";

const personalProject = (id: string, name: string): Project => ({
  id,
  name,
  key: name.toUpperCase(),
  folderPath: null,
  lifecycle: "active",
  deletionPhase: null,
  deleteBatchId: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  version: 1
});

const chat = (
  name: string,
  sessionId: string | null,
  personalProjectId: string | null | undefined,
  input: Partial<PersonalDesktopProjectThread> = {}
): PersonalDesktopProjectThread => ({
  id: `thread-${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  sessionId,
  originDevice: null,
  sourceAiClient: "codex",
  projectId: "technical-project",
  personalProjectId,
  projectName: "Technical project",
  projectPath: null,
  projectAssignmentSource: null,
  eventCount: 1,
  invalidatedCount: 0,
  latestAt: now,
  sample: "",
  presentation: null,
  threadKind: "conversation",
  ...input
});

const graph = (threads: PersonalDesktopProjectThread[]): DesktopProject[] => [
  {
    id: "technical-project",
    name: "Technical project",
    path: null,
    threads,
    eventCount: threads.length,
    catalogued: false,
    discoveredAt: null,
    lastSeenAt: null,
    localProjectId: null,
    contextKind: "project",
    branch: null,
    isWorktree: false,
    remoteDisplay: null
  }
];

const dragData = () => {
  const values = new Map<string, string>();
  return {
    effectAllowed: "none",
    dropEffect: "none",
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? ""
  };
};

const dragEvent = (
  type: "dragstart" | "dragover" | "drop" | "dragend",
  dataTransfer: ReturnType<typeof dragData>
): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
};

describe("HQ sidebar chat drag and drop", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalDesktop: PropertyDescriptor | undefined;
  const onMoveConversation = vi.fn();

  const render = async (
    threads: PersonalDesktopProjectThread[],
    allowMove = true
  ) => {
    await act(async () => {
      root.render(
        <HqSidebar
          onMoveConversation={allowMove ? onMoveConversation : undefined}
          onOpenSearchAndCommands={() => {}}
          onSelectConversation={() => {}}
          onSelectProject={() => {}}
          personalProjects={[
            personalProject(projectA, "Alpha"),
            personalProject(projectB, "Beta")
          ]}
          projects={graph(threads)}
          route={{ kind: "home" }}
        />
      );
      await Promise.resolve();
    });
  };

  const chatButton = (name: string): HTMLButtonElement => {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(
        "button[data-hq-chat-title]"
      )
    ].find((item) => item.textContent?.trim() === name);
    if (!button) throw new Error(`Missing chat ${name}`);
    return button;
  };

  const projectTarget = (name: string): HTMLLIElement => {
    const row = [
      ...container.querySelectorAll<HTMLLIElement>(".hq-sidebar__project")
    ].find(
      (item) =>
        item.querySelector("[data-hq-project-link]")?.textContent?.trim() ===
        name
    );
    if (!row) throw new Error(`Missing Project ${name}`);
    return row;
  };

  const dispatch = async (target: Element, event: Event) => {
    await act(async () => {
      target.dispatchEvent(event);
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const api: HqSidebarPreferencesApi = {
      get: vi.fn(async () => ({ foldedGroups: {} })),
      set: vi.fn(async (value) => value)
    };
    originalDesktop = Object.getOwnPropertyDescriptor(window, "koedDesktop");
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: { hqSidebar: api }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onMoveConversation.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (originalDesktop)
      Object.defineProperty(window, "koedDesktop", originalDesktop);
    else delete window.koedDesktop;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("moves a local loose chat to a Project using the exact captured Session ID", async () => {
    await render([chat("Loose chat", looseSession, null)]);
    const source = chatButton("Loose chat");
    const target = projectTarget("Alpha");
    const data = dragData();
    expect(source.getAttribute("draggable")).toBe("true");
    await dispatch(source, dragEvent("dragstart", data));
    expect(data.effectAllowed).toBe("move");
    expect(data.getData(mime)).toBe(looseSession);
    expect(
      container
        .querySelector(".hq-sidebar__loose-group")
        ?.getAttribute("data-hq-dragging")
    ).toBe("true");
    const over = dragEvent("dragover", data);
    await dispatch(target, over);
    expect(over.defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe("move");
    expect(target.getAttribute("data-hq-drop-active")).toBe("true");
    await dispatch(target, dragEvent("drop", data));
    expect(onMoveConversation).toHaveBeenCalledExactlyOnceWith(
      looseSession,
      null,
      projectA
    );
    expect(target.hasAttribute("data-hq-drop-active")).toBe(false);
  });

  it("moves a Project chat to empty Chats and ignores its current Project", async () => {
    await render([chat("Project chat", projectSession, projectA)]);
    const source = chatButton("Project chat");
    const loose = container.querySelector<HTMLElement>(
      ".hq-sidebar__loose-group"
    );
    expect(loose).not.toBeNull();
    expect(loose?.querySelector("[data-hq-chat-title]")).toBeNull();
    const same = projectTarget("Alpha");
    const data = dragData();
    await dispatch(source, dragEvent("dragstart", data));
    const sameOver = dragEvent("dragover", data);
    await dispatch(same, sameOver);
    expect(sameOver.defaultPrevented).toBe(false);
    expect(same.hasAttribute("data-hq-drop-active")).toBe(false);
    await dispatch(same, dragEvent("drop", data));
    expect(onMoveConversation).not.toHaveBeenCalled();

    await dispatch(source, dragEvent("dragstart", data));
    await dispatch(loose!, dragEvent("dragover", data));
    expect(loose?.getAttribute("data-hq-drop-active")).toBe("true");
    await dispatch(loose!, dragEvent("drop", data));
    expect(onMoveConversation).toHaveBeenCalledExactlyOnceWith(
      projectSession,
      projectA,
      null
    );
    expect(loose?.hasAttribute("data-hq-drop-active")).toBe(false);
  });

  it("rejects remote, unsessioned, unowned, and subagent rows", async () => {
    await render([
      chat("Remote chat", looseSession, null, {
        originDevice: { id: "remote-device", name: "Other desktop" }
      }),
      chat("Draft chat", null, null),
      chat("Unowned HQ", projectSession, undefined),
      chat("Subagent", projectSession, projectA, {
        threadKind: "subagent"
      })
    ]);
    expect(chatButton("Remote chat").getAttribute("draggable")).toBe("false");
    expect(chatButton("Draft chat").getAttribute("draggable")).toBe("false");
    expect(container.textContent).not.toContain("Unowned HQ");
    expect(container.textContent).not.toContain("Subagent");
    const data = dragData();
    await dispatch(chatButton("Remote chat"), dragEvent("dragstart", data));
    await dispatch(projectTarget("Beta"), dragEvent("drop", data));
    expect(data.getData(mime)).toBe("");
    expect(onMoveConversation).not.toHaveBeenCalled();
  });

  it("clears target highlight on drag end and rejects a forged payload", async () => {
    await render([chat("Loose chat", looseSession, null)]);
    const source = chatButton("Loose chat");
    const target = projectTarget("Beta");
    const data = dragData();
    await dispatch(source, dragEvent("dragstart", data));
    await dispatch(target, dragEvent("dragover", data));
    expect(target.getAttribute("data-hq-drop-active")).toBe("true");
    await dispatch(source, dragEvent("dragend", data));
    expect(target.hasAttribute("data-hq-drop-active")).toBe(false);

    await dispatch(source, dragEvent("dragstart", data));
    data.setData(mime, projectSession);
    await dispatch(target, dragEvent("drop", data));
    expect(onMoveConversation).not.toHaveBeenCalled();
  });

  it("does not enable dragging before the move callback is available", async () => {
    await render([chat("Loose chat", looseSession, null)], false);
    const source = chatButton("Loose chat");
    expect(source.getAttribute("draggable")).toBe("false");
    const data = dragData();
    await dispatch(source, dragEvent("dragstart", data));
    await dispatch(projectTarget("Alpha"), dragEvent("dragover", data));
    await dispatch(projectTarget("Alpha"), dragEvent("drop", data));
    expect(data.getData(mime)).toBe("");
    expect(onMoveConversation).not.toHaveBeenCalled();
  });
});
