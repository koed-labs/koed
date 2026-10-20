// @vitest-environment happy-dom

import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import type { Agent } from "@koed/shared/agent-contract";
import type { Project } from "@koed/shared/project-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  HqSidebarPreferences,
  HqSidebarPreferencesApi
} from "../../ipc/hq-sidebar-preferences-protocol.js";
import type { DesktopProject } from "../../project-memory-ui.js";
import type { HqRoute } from "./hq-navigation.js";
import { HqSidebar } from "./HqSidebar.js";

const actEnvironment = globalThis as {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const timestamp = (day: number): string =>
  `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`;

const thread = (
  projectId: string,
  sessionId: string,
  index: number,
  threadKind: "conversation" | "subagent" = "conversation"
): PersonalDesktopProjectThread => ({
  eventCount: 1,
  id: `${projectId}-thread-${index}`,
  invalidatedCount: 0,
  latestAt: timestamp(Math.max(1, 25 - index)),
  name: threadKind === "subagent" ? `Agent ${index}` : `Chat ${index}`,
  originDevice: null,
  parentSessionId: threadKind === "subagent" ? sessionId : null,
  parentThreadId: threadKind === "subagent" ? `${projectId}-parent` : null,
  projectAssignmentSource: null,
  projectId,
  projectName: projectId,
  projectPath: null,
  presentation: null,
  sample: "",
  sessionId,
  sourceAiClient: null,
  threadKind
});

const project = (
  id: string,
  name: string,
  count: number,
  contextKind: "project" | "independent" = "project"
): DesktopProject => ({
  branch: null,
  catalogued: false,
  contextKind,
  discoveredAt: null,
  eventCount: count,
  id,
  isWorktree: false,
  lastSeenAt: null,
  localProjectId: null,
  name,
  path: null,
  remoteDisplay: null,
  threads: Array.from({ length: count }, (_, index) =>
    thread(
      id,
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      index + 1
    )
  ).concat(
    thread(
      id,
      `00000000-0000-4000-8000-${String(count + 1).padStart(12, "0")}`,
      count + 1,
      "subagent"
    )
  )
});

const initialRoute: HqRoute = { kind: "home" };

describe("HQ sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rootUnmounted = false;
  let desktopDescriptor: PropertyDescriptor | undefined;
  let persisted: HqSidebarPreferences;
  let api: HqSidebarPreferencesApi;
  const projects = [
    project("project-a", "Alpha", 4),
    project("project-b", "Beta", 4),
    project("loose-chats", "Chats", 7, "independent")
  ];
  const onSelectProject = vi.fn();
  const onSelectConversation = vi.fn();
  const onOpenSearchAndCommands = vi.fn();
  const onRetryProjects = vi.fn();

  const render = async (
    route: HqRoute = initialRoute,
    options: {
      conversationAgents?: Readonly<Record<string, Agent>>;
      groupsReady?: boolean;
      loading?: boolean;
      projectsError?: boolean;
      nowActive?: boolean;
      onOpenNow?: () => void;
      personalProjects?: readonly Project[];
      onDeleteProject?: (projectId: string) => void;
      onCreateProject?: () => void;
    } = {},
    renderedProjects: readonly DesktopProject[] = projects
  ) => {
    await act(async () => {
      root.render(
        <HqSidebar
          conversationAgents={options.conversationAgents}
          groupsReady={options.groupsReady}
          loading={options.loading}
          onOpenSearchAndCommands={onOpenSearchAndCommands}
          onRetryProjects={onRetryProjects}
          onOpenNow={options.onOpenNow}
          personalProjects={options.personalProjects}
          onDeleteProject={options.onDeleteProject}
          onCreateProject={options.onCreateProject}
          nowActive={options.nowActive}
          onSelectConversation={onSelectConversation}
          onSelectProject={onSelectProject}
          projectsError={options.projectsError}
          projects={renderedProjects}
          route={route}
        />
      );
      rootUnmounted = false;
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    persisted = { foldedGroups: {} };
    api = {
      get: vi.fn(async () => structuredClone(persisted)),
      set: vi.fn(async (next) => {
        persisted = structuredClone(next);
        return structuredClone(persisted);
      })
    };
    desktopDescriptor = Object.getOwnPropertyDescriptor(window, "koedDesktop");
    Object.defineProperty(window, "koedDesktop", {
      configurable: true,
      value: { hqSidebar: api }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    rootUnmounted = false;
    onSelectProject.mockClear();
    onSelectConversation.mockClear();
    onOpenSearchAndCommands.mockClear();
    onRetryProjects.mockClear();
  });

  afterEach(async () => {
    if (!rootUnmounted) {
      await act(async () => root.unmount());
      rootUnmounted = true;
    }
    container.remove();
    if (desktopDescriptor) {
      Object.defineProperty(window, "koedDesktop", desktopDescriptor);
    } else {
      delete window.koedDesktop;
    }
    vi.restoreAllMocks();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("keeps v50 Now navigation and places a Pixelkin only on a known Agent Conversation", async () => {
    const canvas = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(null);
    const agent = { id: "agent-quinn", name: "Quinn", look: {} } as Agent;
    const sessionId = "00000000-0000-4000-8000-000000000001";
    try {
      await render(
        initialRoute,
        {
          onOpenNow: () => undefined,
          conversationAgents: { [sessionId]: agent }
        },
        [projects[0]!]
      );
      expect(
        container.querySelector(".hq-sidebar__action--now svg")
      ).not.toBeNull();
      expect(
        container.querySelector(".hq-sidebar__action--now canvas")
      ).toBeNull();
      expect(
        container.querySelectorAll('[aria-label="Quinn Pixelkin"]')
      ).toHaveLength(1);
      expect(
        container
          .querySelector('[aria-label="Quinn Pixelkin"]')
          ?.closest("button")?.textContent
      ).toContain("Chat 1");
      await render(
        initialRoute,
        { onOpenNow: () => undefined, conversationAgents: {} },
        [projects[0]!]
      );
      expect(container.querySelector("canvas")).toBeNull();
    } finally {
      canvas.mockRestore();
    }
  });

  it("renders real personal groups, caps lists, and filters subagents", async () => {
    await render();

    expect(
      container.querySelector('[data-hq-sidebar-group="just-me"]')
    ).not.toBeNull();
    expect(
      [...container.querySelectorAll("[data-hq-project-link]")].map(
        (element) => element.textContent
      )
    ).toEqual(["Alpha", "Beta"]);
    expect(container.querySelectorAll("[data-hq-chat-title]")).toHaveLength(11);
    expect(
      [...container.querySelectorAll("[data-hq-chat-title]")].some((element) =>
        element.textContent?.startsWith("Agent")
      )
    ).toBe(false);
    expect(
      [...container.querySelectorAll(".hq-sidebar__more")].map(
        (element) => element.textContent
      )
    ).toEqual(["Show 1 more", "Show 1 more", "Show 2 more"]);
    expect(container.textContent).not.toContain("Shared");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".hq-sidebar__more")?.click();
    });
    expect(container.querySelectorAll("[data-hq-chat-title]")).toHaveLength(12);
  });

  it("shows a retry state on project-load errors while retaining loaded rows", async () => {
    await render(initialRoute, { groupsReady: false, projectsError: true });

    expect(container.textContent).toContain("Projects could not be loaded.");
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).not.toContain("No Projects or Chats yet");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-hq-project-retry]")
        ?.click();
    });
    expect(onRetryProjects).toHaveBeenCalledOnce();

    await render(initialRoute, { groupsReady: false, projectsError: true }, []);
    expect(container.textContent).toContain("Projects could not be loaded.");
    expect(container.textContent).not.toContain("No Projects or Chats yet");
  });

  it("keeps primary fork/resume Conversations and caps after filtering subagents", async () => {
    const forkProject = project("forked-project", "Forked", 4);
    const primaryConversation = forkProject.threads[0];
    expect(primaryConversation).toBeDefined();
    const forkedProjects: DesktopProject[] = [
      {
        ...forkProject,
        threads: forkProject.threads.map((conversation, index) =>
          index === 0
            ? {
                ...conversation,
                parentSessionId: conversation.sessionId,
                parentThreadId: "resumed-primary-parent"
              }
            : conversation
        )
      }
    ];

    await render(initialRoute, {}, forkedProjects);

    expect(container.querySelectorAll("[data-hq-chat-title]")).toHaveLength(3);
    expect(container.querySelector("[data-hq-chat-title]")?.textContent).toBe(
      "Chat 1"
    );
    expect(container.textContent).toContain("Show 1 more");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".hq-sidebar__more")?.click();
    });

    expect(container.querySelectorAll("[data-hq-chat-title]")).toHaveLength(4);
    expect(
      [...container.querySelectorAll("[data-hq-chat-title]")].some((element) =>
        element.textContent?.startsWith("Agent")
      )
    ).toBe(false);
  });

  it("keeps project and conversation selection scoped and preserves scroll", async () => {
    const selectedRoute: HqRoute = {
      kind: "conversation",
      projectId: "project-b",
      sessionId: "00000000-0000-4000-8000-000000000001"
    };
    await render(selectedRoute);

    const selectedChats = container.querySelectorAll(
      '[data-hq-chat-row][data-selected="true"]'
    );
    expect(selectedChats).toHaveLength(1);
    expect(
      [...selectedChats].map((element) =>
        element.getAttribute("data-hq-chat-project")
      )
    ).toEqual(["project-b"]);
    expect(
      container.querySelector(
        '[data-hq-project-link="project-b"][data-selected="true"]'
      )
    ).toBeNull();
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(
      container
        .querySelector('[data-hq-project-link="project-b"]')
        ?.hasAttribute("aria-current")
    ).toBe(false);
    expect(
      container.querySelectorAll('[data-hq-chat-row][aria-current="page"]')
    ).toHaveLength(1);

    const scroll = container.querySelector<HTMLElement>(
      "[data-hq-sidebar-scroll]"
    );
    expect(scroll).not.toBeNull();
    if (!scroll) return;
    scroll.scrollTop = 86;
    scroll.dispatchEvent(new Event("scroll"));

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          "[data-hq-project-row] .hq-sidebar__project-link"
        )
        ?.click();
    });
    expect(onSelectProject).toHaveBeenCalledWith("project-a");
    await render({ kind: "project", projectId: "project-a" });
    expect(scroll.scrollTop).toBe(86);
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(
      container
        .querySelector('[data-hq-project-link="project-a"]')
        ?.getAttribute("aria-current")
    ).toBe("page");

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-hq-chat-row]")?.click();
    });
    expect(onSelectConversation).toHaveBeenCalledWith(
      "project-a",
      "00000000-0000-4000-8000-000000000001"
    );
  });

  it("opens Search and commands on Meta+K or Ctrl+K and removes the listener on unmount", async () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    await render();

    const keydownCalls = addListener.mock.calls.filter(
      ([type]) => type === "keydown"
    );
    const shortcutListener = keydownCalls.at(-1)?.[1];
    expect(shortcutListener).toBeTypeOf("function");

    const metaK = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "k",
      metaKey: true
    });
    const ctrlK = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "k"
    });
    await act(async () => {
      window.dispatchEvent(metaK);
      window.dispatchEvent(ctrlK);
    });

    expect(metaK.defaultPrevented).toBe(true);
    expect(ctrlK.defaultPrevented).toBe(true);
    expect(onOpenSearchAndCommands).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    rootUnmounted = true;
    expect(removeListener).toHaveBeenCalledWith("keydown", shortcutListener);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { ctrlKey: true, key: "k" })
    );
    expect(onOpenSearchAndCommands).toHaveBeenCalledTimes(2);
  });

  it("marks Now as current only while its destination is active", async () => {
    const openNow = vi.fn();
    await render({ kind: "home" }, { onOpenNow: openNow, nowActive: true });
    const now = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Now"]'
    );
    expect(now?.getAttribute("aria-current")).toBe("page");
    await act(async () => now?.click());
    expect(openNow).toHaveBeenCalledOnce();
    await render(
      { kind: "project", projectId: "project-a" },
      { onOpenNow: openNow, nowActive: false }
    );
    expect(now?.hasAttribute("aria-current")).toBe(false);
  });

  it("persists folds across remounts while leaving future actions unavailable", async () => {
    await render();
    const newChat = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New chat"]'
    );
    const newProject = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New project"]'
    );
    const now = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Now"]'
    );
    expect(newChat?.disabled).toBe(true);
    expect(newProject?.disabled).toBe(true);
    expect(now?.disabled).toBe(true);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-hq-sidebar-group="just-me"]')
        ?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(api.set).toHaveBeenCalledOnce());
    expect(
      container.querySelector("#hq-group-just-me")?.hasAttribute("hidden")
    ).toBe(true);
    expect(persisted.foldedGroups["just-me"]).toBe(true);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(
      container.querySelector("#hq-group-just-me")?.hasAttribute("hidden")
    ).toBe(true);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Search and commands"]'
        )
        ?.click();
    });
    expect(onOpenSearchAndCommands).toHaveBeenCalledOnce();
  });

  it("does not prune remembered groups during Projects loading or error", async () => {
    persisted = { foldedGroups: { "project:previously-known": true } };

    await render(initialRoute, { groupsReady: false, loading: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(api.set).not.toHaveBeenCalled();

    await render(initialRoute, { groupsReady: false, loading: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(api.set).not.toHaveBeenCalled();

    await render(initialRoute, { groupsReady: true, loading: false });
    await vi.waitFor(() => expect(api.set).toHaveBeenCalledOnce());
    expect(api.set).toHaveBeenCalledWith({ foldedGroups: {} });
  });

  it("keeps a fold intent locally when an incomplete list would exceed the native cap", async () => {
    const staleGroups = Object.fromEntries(
      Array.from({ length: 1001 }, (_, index) => [
        `project:stale-${index}`,
        true
      ])
    );
    persisted = { foldedGroups: staleGroups };

    await render(
      { kind: "project", projectId: "project-a" },
      { groupsReady: false, loading: true }
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-hq-project-link="project-a"]')
        ?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      container
        .querySelector<HTMLButtonElement>('[data-hq-project-link="project-a"]')
        ?.closest("li")
        ?.querySelector(".hq-sidebar__nested-list")
        ?.hasAttribute("hidden")
    ).toBe(true);
    expect(api.set).not.toHaveBeenCalled();

    await render(initialRoute, { groupsReady: true, loading: false });
    await vi.waitFor(() => expect(api.set).toHaveBeenCalledOnce());
    const saved = vi.mocked(api.set).mock.calls[0]?.[0];
    expect(saved?.foldedGroups).toEqual({ "project:project-a": true });
    expect(Object.keys(saved?.foldedGroups ?? {}).length).toBeLessThanOrEqual(
      1001
    );
  });
  it("selects a Project before repeated row activation folds its Conversations", async () => {
    await render();
    const row = container.querySelector<HTMLButtonElement>(
      '[data-hq-project-link="project-a"]'
    );
    await act(async () => row?.click());
    expect(onSelectProject).toHaveBeenCalledWith("project-a");
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    await render({ kind: "project", projectId: "project-a" });
    await act(async () => row?.click());
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => row?.click());
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector("[data-hq-project-chevron], [data-hq-chat-icon]")
    ).toBeNull();
  });

  it("renders the supplied real account identity and enables only its connected Settings action", async () => {
    const onOpenSettings = vi.fn();
    await act(async () =>
      root.render(
        <HqSidebar
          projects={[]}
          route={initialRoute}
          accountIdentity={{ displayName: "Test User", status: "Connected" }}
          onOpenSettings={onOpenSettings}
          onOpenSearchAndCommands={onOpenSearchAndCommands}
          onSelectConversation={onSelectConversation}
          onSelectProject={onSelectProject}
        />
      )
    );
    const account = container.querySelector<HTMLButtonElement>(".hq-account");
    expect(account?.textContent).toContain("Test User");
    expect(account?.textContent).toContain("Connected");
    expect(container.querySelector(".hq-account__avatar")?.textContent).toBe(
      "TU"
    );
    await act(async () => account?.click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("opens the Personal Project menu by ellipsis and right click, without offering Leave", async () => {
    const onDeleteProject = vi.fn();
    const personalProjects: Project[] = [
      {
        id: "project-a",
        name: "Alpha",
        key: "ALPHA",
        folderPath: null,
        lifecycle: "active",
        deletionPhase: null,
        deleteBatchId: null,
        deletedAt: null,
        createdAt: timestamp(1),
        updatedAt: timestamp(1),
        version: 1
      }
    ];
    await render(initialRoute, { personalProjects, onDeleteProject });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-hq-project-menu-trigger="project-a"]'
    );
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    expect(container.querySelector('[role="menu"]')?.textContent).toContain(
      "Delete project"
    );
    expect(container.querySelector('[role="menu"]')?.textContent).not.toContain(
      "Leave project"
    );
    const share = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ].find((item) => item.textContent === "Share");
    expect(share?.disabled).toBe(true);
    const deleteButton = [
      ...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ].find((item) => item.textContent === "Delete project");
    await act(async () => deleteButton?.click());
    expect(onDeleteProject).toHaveBeenCalledWith("project-a");
    const row = container.querySelector<HTMLElement>("[data-hq-project-row]");
    await act(async () =>
      row?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
      )
    );
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement?.textContent).toBe("Open HQ");
    await act(async () =>
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
      )
    );
    expect(document.activeElement?.textContent).toBe("Delete project");
    await act(async () =>
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true })
      )
    );
    expect(document.activeElement?.textContent).toBe("Open HQ");
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});
