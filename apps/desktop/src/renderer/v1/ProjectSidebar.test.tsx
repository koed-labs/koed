// @vitest-environment happy-dom
import { act } from "react";
import { Storage } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationShell } from "./NavigationShell.js";
import { useNavigationHistory } from "./use-navigation-history.js";
import type { SidebarProject } from "./project-sidebar-model.js";
import type { SidebarLive, SidebarManagement } from "./ProjectSidebar.js";

const projects: SidebarProject[] = [
  {
    id: "project",
    name: "Koed",
    latestAt: "2026-10-29T12:00:00Z",
    conversations: [
      {
        key: "session:one",
        aliases: ["session:one"],
        title: "Captured from Claude",
        client: "claude",
        latestAt: "2026-10-29T12:00:00Z",
        route: { kind: "conversation", projectId: "project", threadId: "one" },
        projectName: "Koed"
      }
    ]
  }
];
const projectWithConversations = (
  id: string,
  name: string,
  count: number
): SidebarProject => ({
  id,
  name,
  latestAt: "2026-10-29T12:00:00Z",
  conversations: Array.from({ length: count }, (_, index) => ({
    key: `session:${id}-${index + 1}`,
    aliases: [`session:${id}-${index + 1}`],
    title: `${name} conversation ${index + 1}`,
    client: "codex",
    latestAt: "2026-10-29T12:00:00Z",
    route: {
      kind: "conversation",
      projectId: id,
      threadId: `${id}-${index + 1}`
    },
    projectName: name
  }))
});
function Harness({
  scope = "owner-a",
  data = projects,
  reveal = null,
  servicesStarting = false,
  loading = false,
  inventoryReady = true,
  management,
  live
}: {
  management?: SidebarManagement;
  live?: SidebarLive;
  scope?: string;
  data?: SidebarProject[];
  reveal?: { projectId: string; key: number } | null;
  servicesStarting?: boolean;
  loading?: boolean;
  inventoryReady?: boolean;
}) {
  const navigation = useNavigationHistory(scope);
  return (
    <NavigationShell
      projects={data}
      revealProject={reveal}
      servicesStarting={servicesStarting}
      loading={loading}
      inventoryReady={inventoryReady}
      scopeKey={scope}
      route={navigation.route}
      onSelect={navigation.navigate}
      onHome={() => navigation.navigate({ kind: "home" })}
      onSettings={() => {}}
      onBack={navigation.back}
      onForward={navigation.forward}
      canGoBack={navigation.canGoBack}
      canGoForward={navigation.canGoForward}
      onRetry={() => {}}
      {...(management ? { management } : {})}
      {...(live ? { kinLive: live } : {})}
    >
      <p data-testid="route">{JSON.stringify(navigation.route)}</p>
    </NavigationShell>
  );
}
let root: Root;
let container: HTMLDivElement;
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === label
  )!;
const searchInput = () =>
  container.querySelector<HTMLInputElement>(
    'input[aria-label="Find Projects or Conversations"]'
  )!;
const searchFor = async (term: string) => {
  const input = searchInput();
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(input, term);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: new Storage()
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1308
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.koedDesktop;
});

describe("Project sidebar interactions", () => {
  it("keeps settings in the Project row actions, without counts", async () => {
    const onProjectSettings = vi.fn();
    const management: SidebarManagement = {
      onCreateProject: () => {},
      onProjectSettings,
      onConversationAction: () => {},
      onDrop: async () => true
    };
    await act(async () =>
      root.render(
        <Harness
          management={management}
          data={[
            { ...projectWithConversations("a", "Koed", 3), managed: true },
            { ...projectWithConversations("b", "Quiet", 2), managed: true }
          ]}
        />
      )
    );
    expect(container.querySelectorAll(".v1-pm-coin")).toHaveLength(0);
    await act(async () => button("Actions for Project Koed")?.click());
    expect(menuItem("Project settings")).toBeDefined();
    await act(async () => menuItem("Project settings").click());
    expect(onProjectSettings).toHaveBeenCalledWith("a");
  });

  it("pins Projects and nested Conversations per account/backend scope", async () => {
    const data = [
      ...projects,
      {
        ...projectWithConversations("empty", "Empty Project", 0),
        managed: true
      }
    ];
    const render = async (scope = "backend-a:owner-a") =>
      act(async () => root.render(<Harness data={data} scope={scope} />));
    const projectNames = () =>
      [...container.querySelectorAll<HTMLButtonElement>(".v1-nav-project")].map(
        (element) => element.textContent
      );
    const pinnedProjects = () =>
      [...container.querySelectorAll<HTMLButtonElement>(".v1-nav-project")]
        .filter((element) => element.querySelector(".v1-nav-pin-mark"))
        .map((element) => element.textContent);
    const pinnedTitles = () =>
      [...container.querySelectorAll(".v1-nav-projects .v1-nav-children li")]
        .filter((row) => row.querySelector(".v1-nav-pin-mark"))
        .map((row) => row.querySelector(".v1-nav-copy > span")?.textContent);

    await render();
    expect(projectNames()).toEqual(["Koed", "Empty Project"]);
    expect(button("Actions for Project Koed")).toBeNull();
    await act(async () => button("Actions for Captured from Claude").click());
    await act(async () => menuItem("Pin").click());
    await act(async () => button("Actions for Project Empty Project")?.click());
    await act(async () => menuItem("Pin Project").click());
    expect(pinnedTitles()).toEqual(["Captured from Claude"]);
    expect(projectNames()).toEqual(["Empty Project", "Koed"]);
    expect(pinnedProjects()).toEqual(["Empty Project"]);
    expect(
      container
        .querySelector(".v1-nav-children .v1-nav-pin-mark")
        ?.closest("li")?.textContent
    ).toContain("Captured from Claude");
    expect(
      window.localStorage.getItem("koed:sidebar-pins:backend-a:owner-a")
    ).toBe('["session:one","project:empty"]');

    await render("backend-a:owner-b");
    expect(pinnedTitles()).toEqual([]);
    expect(projectNames()).toEqual(["Koed", "Empty Project"]);
    await render("backend-b:owner-a");
    expect(pinnedProjects()).toEqual([]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(pinnedTitles()).toEqual(["Captured from Claude"]);
    expect(projectNames()).toEqual(["Empty Project", "Koed"]);

    await act(async () => button("Actions for Project Empty Project").click());
    await act(async () => menuItem("Unpin Project").click());
    expect(projectNames()).toEqual(["Koed", "Empty Project"]);
    expect(pinnedProjects()).toEqual([]);
    expect(
      window.localStorage.getItem("koed:sidebar-pins:backend-a:owner-a")
    ).toBe('["session:one"]');
  });

  it("lists Conversations without a Git Anchor or Folder under No anchor", async () => {
    const noProject = projectWithConversations("no-project", "No project", 1);
    const named: SidebarProject = {
      ...projectWithConversations("named", "Koed", 1),
      managed: true
    };
    const anchor: SidebarProject = {
      ...projectWithConversations("repository:koed", "Koed repo", 1),
      source: "git"
    };
    await act(async () =>
      root.render(<Harness data={[named, noProject, anchor]} />)
    );
    const open = async (label: string) => {
      const trigger = [
        ...container.querySelectorAll<HTMLButtonElement>("button")
      ].find((item) => item.textContent === label);
      expect(trigger).toBeDefined();
      await act(async () => trigger!.click());
    };
    expect(container.querySelector(".v1-nav-conversations")).toBeNull();
    await open("Anchors");
    await open("No anchor");
    const anchors = container.querySelector(".v1-nav-anchors");
    expect(anchors?.textContent).toContain("No project conversation 1");
    expect(anchors?.textContent).toContain("Koed conversation 1");
    expect(anchors?.textContent).not.toContain("Koed repo conversation 1");
    expect(button("Actions for No anchor")).toBeNull();
  });

  it("opens one Conversation across Project and Anchor copies without a duplicate history stop", async () => {
    const project = {
      ...projectWithConversations("a", "Alpha", 1),
      managed: true
    };
    const anchor = projectWithConversations("git", "Repo", 1);
    await act(async () =>
      root.render(
        <Harness
          data={[
            project,
            {
              ...anchor,
              source: "git",
              conversations: [
                {
                  ...anchor.conversations[0]!,
                  key: "session:a-1",
                  aliases: ["session:a-1"],
                  title: "Alpha conversation 1"
                }
              ]
            }
          ]}
        />
      )
    );
    await searchFor("Alpha conversation");
    const inProject = () =>
      container.querySelector<HTMLButtonElement>(
        ".v1-nav-projects .v1-nav-conversation"
      )!;
    const inAnchor = () =>
      container.querySelector<HTMLButtonElement>(
        ".v1-nav-anchors .v1-nav-conversation"
      )!;
    const route = () =>
      JSON.parse(
        container.querySelector('[data-testid="route"]')!.textContent!
      );
    await act(async () => inProject().click());
    expect(inProject().getAttribute("aria-current")).toBe("page");
    expect(inAnchor().hasAttribute("data-also-open")).toBe(true);
    expect(route()).toMatchObject({
      conversationKey: "session:a-1",
      originGroupId: "a"
    });
    await act(async () => inAnchor().click());
    expect(inAnchor().getAttribute("aria-current")).toBe("page");
    expect(inProject().hasAttribute("data-also-open")).toBe(true);
    expect(route()).toMatchObject({
      conversationKey: "session:a-1",
      originGroupId: "git"
    });
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    await act(async () => button("Go back").click());
    expect(route()).toEqual({ kind: "home" });
  });

  it("offers memberships first and only offers Move for a single named membership", async () => {
    const onConversationAction = vi.fn();
    const management: SidebarManagement = {
      onCreateProject: () => {},
      onProjectSettings: () => {},
      onConversationAction,
      onDrop: async () => true
    };
    const a = { ...projectWithConversations("a", "Alpha", 1), managed: true };
    a.conversations[0]!.sessionId = "a-1";
    const b = { ...a, id: "b", name: "Beta" };
    await act(async () =>
      root.render(<Harness data={[a, b]} management={management} />)
    );
    await act(async () => button("Actions for Alpha conversation 1").click());
    expect(document.querySelector('[role="menuitem"]')?.textContent).toBe(
      "Project memberships"
    );
    expect(menuItem("Move to Project")).toBeUndefined();
    await act(async () => menuItem("Project memberships").click());
    expect(onConversationAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "a-1" }),
      "membership"
    );
    await act(async () =>
      root.render(<Harness data={[a]} management={management} />)
    );
    await act(async () => button("Actions for Alpha conversation 1").click());
    await act(async () => menuItem("Move to Project").click());
    expect(onConversationAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceProjectId: "a" }),
      "move"
    );
  });

  it("drags a Conversation out of the Project it was dragged from, even with other memberships", async () => {
    const onDrop = vi.fn(async () => true);
    const management: SidebarManagement = {
      onCreateProject: () => {},
      onProjectSettings: () => {},
      onConversationAction: () => {},
      onDrop
    };
    const inProject = (id: string, name: string) => {
      const project = {
        ...projectWithConversations("a", "Alpha", 1),
        managed: true
      };
      return {
        ...project,
        id,
        name,
        conversations: project.conversations.map((row) => ({
          ...row,
          sessionId: "a-1",
          sourceProjectId: id
        }))
      };
    };
    const c = { ...projectWithConversations("c", "Gamma", 1), managed: true };
    await act(async () =>
      root.render(
        <Harness
          data={[inProject("a", "Alpha"), inProject("b", "Beta"), c]}
          management={management}
        />
      )
    );
    const row = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".v1-nav-projects .v1-nav-conversation"
      )
    ].find((element) => element.closest('[data-project-drop="a"]'))!;
    expect(row).toBeDefined();
    const dropTarget = container.querySelector('[data-project-drop="c"]')!;
    const elementFromPoint = vi
      .spyOn(document, "elementFromPoint")
      .mockReturnValue(dropTarget);
    row.setPointerCapture = () => {};
    const pointer = (type: string, x: number) =>
      new PointerEvent(type, {
        bubbles: true,
        button: 0,
        pointerId: 1,
        pointerType: "mouse",
        clientX: x,
        clientY: 10
      });
    try {
      await act(async () => {
        row.dispatchEvent(pointer("pointerdown", 10));
        row.dispatchEvent(pointer("pointermove", 40));
        row.dispatchEvent(pointer("pointerup", 40));
      });
    } finally {
      elementFromPoint.mockRestore();
    }
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "a-1", sourceProjectId: "a" }),
      "c"
    );
  });

  it("clears an Anchor drag on Escape and suppresses the release click", async () => {
    const onDrop = vi.fn(async () => true);
    const source = projectWithConversations("repo", "Repository", 1);
    const management: SidebarManagement = {
      onCreateProject: () => {},
      onProjectSettings: () => {},
      onConversationAction: () => {},
      onDrop
    };
    await act(async () =>
      root.render(
        <Harness
          data={[
            {
              ...source,
              source: "git",
              conversations: source.conversations.map((row) => ({
                ...row,
                sessionId: "repo-1"
              }))
            },
            { ...projectWithConversations("a", "Alpha", 0), managed: true }
          ]}
          management={management}
        />
      )
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          ".v1-nav-anchors .v1-nav-heading-toggle"
        )!
        .click()
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".v1-nav-anchors .v1-nav-project")!
        .click()
    );
    const row = container.querySelector<HTMLButtonElement>(
      ".v1-nav-anchors .v1-nav-conversation"
    )!;
    row.setPointerCapture = () => {};
    const project = container.querySelector('[data-project-drop="a"]')!;
    const elementFromPoint = vi
      .spyOn(document, "elementFromPoint")
      .mockReturnValue(project);
    const pointer = (type: string, clientX: number) =>
      row.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          pointerId: 1,
          pointerType: "mouse",
          clientX,
          clientY: 25
        })
      );
    const preview = () => document.querySelector(".v1-pm-drag-ghost");
    const route = () =>
      container.querySelector('[data-testid="route"]')?.textContent;
    const popoverKeyDown = vi.fn((event: KeyboardEvent) =>
      event.stopPropagation()
    );
    document.addEventListener("keydown", popoverKeyDown);
    try {
      await act(async () => {
        pointer("pointerdown", 10);
        pointer("pointermove", 14);
      });
      expect(preview()).toBeNull();
      await act(async () => {
        pointer("pointermove", 40);
      });
      expect(preview()?.textContent).toBe("Repository conversation 1");
      expect(
        preview()?.querySelector(".v1-nav-client-mark.codex svg")
      ).not.toBeNull();
      expect(project.classList.contains("v1-pm-drop-target")).toBe(true);

      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true
      });
      await act(async () => {
        row.dispatchEvent(escape);
      });
      expect(escape.defaultPrevented).toBe(true);
      expect(popoverKeyDown).not.toHaveBeenCalled();
      expect(preview()).toBeNull();
      expect(project.classList.contains("v1-pm-drop-target")).toBe(false);
      await act(async () => {
        pointer("pointermove", 60);
        pointer("pointerup", 60);
        row.click();
      });
      expect(onDrop).not.toHaveBeenCalled();
      expect(route()).toBe('{"kind":"home"}');
      await act(async () => {
        pointer("pointerdown", 10);
        pointer("pointerup", 10);
        row.click();
      });
      expect(route()).toContain('"sessionId":"repo-1"');
    } finally {
      document.removeEventListener("keydown", popoverKeyDown);
      elementFromPoint.mockRestore();
    }
  });

  it("keeps loading Projects as the list end comes into view, even when the first page fits", async () => {
    const observers: Array<{
      callback: IntersectionObserverCallback;
      target?: Element;
    }> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        entry: { callback: IntersectionObserverCallback; target?: Element };
        constructor(callback: IntersectionObserverCallback) {
          this.entry = { callback };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.target = target;
        }
        disconnect() {
          this.entry.target = undefined;
        }
      }
    );
    const showEnd = () =>
      act(async () => {
        for (const { callback, target } of observers)
          if (target?.isConnected)
            callback(
              [{ isIntersecting: true, target } as IntersectionObserverEntry],
              {} as IntersectionObserver
            );
      });
    try {
      const many = Array.from({ length: 31 }, (_, index) => ({
        ...projectWithConversations(`p${index}`, `Project ${index + 1}`, 1),
        managed: true
      }));
      await act(async () => root.render(<Harness data={many} />));
      const groups = () =>
        container.querySelectorAll(".v1-nav-projects [data-project-drop]")
          .length;
      expect(groups()).toBe(15);
      expect(button("Load more Projects")).toBeNull();
      await showEnd();
      expect(groups()).toBe(30);
      // The sentinel is still in view on a short list, so it loads again.
      await showEnd();
      expect(groups()).toBe(31);
      expect(container.textContent).not.toContain("Loading more");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("offers Show captured context in a tracked row's Actions, anchored on its marker", async () => {
    const opened: Element[] = [];
    const live: SidebarLive = {
      marker: (row) =>
        row.key === "session:a-1" ? (
          <button type="button" className="fk-row-live">
            live
          </button>
        ) : null,
      preview: (row) =>
        row.key === "session:a-1" ? (anchor) => opened.push(anchor) : null
    };
    await act(async () =>
      root.render(
        <Harness
          data={[projectWithConversations("a", "Alpha", 2)]}
          live={live}
        />
      )
    );
    await act(async () => button("Actions for Alpha conversation 2").click());
    expect(menuItem("Show captured context")).toBeUndefined();
    await act(async () => button("Actions for Alpha conversation 1").click());
    await act(async () => menuItem("Show captured context")!.click());
    expect(opened).toHaveLength(1);
    expect(opened[0]!.classList.contains("fk-row-live")).toBe(true);
    expect(
      opened[0]!.closest(".v1-nav-conversation-wrap")?.textContent
    ).toContain("Alpha conversation 1");
  });

  it("lists Git Anchor and Folder groups under a collapsible Anchors heading", async () => {
    const anchor: SidebarProject = {
      ...projectWithConversations(
        "repository:koed-ai",
        "github.com/koed-labs/koed-ai",
        2
      ),
      source: "git"
    };
    const folder: SidebarProject = {
      ...projectWithConversations("folder:scratch", "scratch", 1),
      source: "folder"
    };
    const named: SidebarProject = {
      ...projectWithConversations("named", "Koed", 1),
      managed: true
    };
    await act(async () =>
      root.render(<Harness data={[named, anchor, folder]} />)
    );
    const heading = (name: string) =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".v1-nav-heading-toggle"
        )
      ].find((toggle) => toggle.textContent === name)!;
    expect(
      container.querySelectorAll(".v1-nav-anchors .v1-nav-project")
    ).toHaveLength(0);
    await act(async () => heading("Anchors").click());
    const section = (name: string) =>
      [...container.querySelectorAll(".v1-nav-project")]
        .filter((row) =>
          row.closest(
            name === "Anchors" ? ".v1-nav-anchors" : ".v1-nav-projects"
          )
        )
        .map((row) => row.textContent);
    expect(section("Projects")).toEqual(["Koed"]);
    expect(section("Anchors")).toEqual([
      "github.com/koed-labs/koed-ai",
      "scratch",
      "No anchor"
    ]);
    // Anchors expand to their Conversations like Projects.
    const anchorRow = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".v1-nav-anchors .v1-nav-project"
      )
    ][0]!;
    await act(async () => anchorRow.click());
    expect(
      anchorRow
        .closest('[data-slot="sidebar-menu-item"]')!
        .querySelectorAll(".v1-nav-conversation")
    ).toHaveLength(2);

    await act(async () => heading("Projects").click());
    expect(section("Projects")).toEqual([]);
    expect(section("Anchors")).toHaveLength(3);
    await act(async () => heading("Anchors").click());
    expect(section("Anchors")).toEqual([]);
    expect(button("Collapse all Projects")).toBeNull();
  });

  it("starts with Anchors collapsed and loads more Projects and Anchors as they scroll", async () => {
    const named = Array.from({ length: 20 }, (_, index) => ({
      ...projectWithConversations(`p${index}`, `Project ${index}`, 1),
      managed: true
    }));
    const anchors = Array.from({ length: 18 }, (_, index) => ({
      ...projectWithConversations(`a${index}`, `anchor-${index}`, 1),
      source: "folder" as const
    }));
    await act(async () =>
      root.render(<Harness data={[...named, ...anchors]} />)
    );
    const count = (section: string) =>
      container.querySelectorAll(`${section} .v1-nav-project`).length;
    expect(count(".v1-nav-projects")).toBe(15);
    expect(count(".v1-nav-anchors")).toBe(0);
    const scrollToEnd = (section: string) =>
      act(async () => {
        const area = container.querySelector<HTMLElement>(section)!;
        Object.defineProperties(area, {
          scrollHeight: { configurable: true, value: 1_000 },
          clientHeight: { configurable: true, value: 300 },
          scrollTop: { configurable: true, writable: true, value: 700 }
        });
        area.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
    await scrollToEnd(".v1-nav-projects");
    expect(count(".v1-nav-projects")).toBe(20);
    const anchorsHeading = [
      ...container.querySelectorAll<HTMLButtonElement>(".v1-nav-heading-toggle")
    ].find((toggle) => toggle.textContent === "Anchors")!;
    await act(async () => anchorsHeading.click());
    expect(count(".v1-nav-anchors")).toBe(16);
    expect(container.querySelector(".v1-nav-anchors")?.textContent).toContain(
      "No anchor"
    );
    await scrollToEnd(".v1-nav-anchors");
    expect(count(".v1-nav-anchors")).toBe(19);
  });

  it("orders pinned Conversations first inside their Project", async () => {
    window.localStorage.setItem(
      "koed:sidebar-pins:owner-a",
      '["session:many-3"]'
    );
    await act(async () =>
      root.render(
        <Harness data={[projectWithConversations("many", "Many", 4)]} />
      )
    );
    const nested = [
      ...container.querySelectorAll(".v1-nav-children .v1-nav-copy > span")
    ].map((title) => title.textContent);
    expect(nested[0]).toBe("Many conversation 3");
    expect(nested.slice(1)).toEqual([
      "Many conversation 1",
      "Many conversation 2",
      "Many conversation 4"
    ]);
  });

  it("opens one Project at a time, reveals five Conversations at a time, and resets on collapse and owner changes", async () => {
    const data = [
      projectWithConversations("a", "Alpha", 12),
      projectWithConversations("b", "Beta", 7)
    ];
    const projectButton = (name: string) =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(".v1-nav-project")
      ].find((element) => element.querySelector("span")?.textContent === name)!;
    const rows = (name: string) =>
      projectButton(name)
        .closest('[data-slot="sidebar-menu-item"]')!
        .querySelectorAll(".v1-nav-conversation");
    await act(async () => root.render(<Harness data={data} />));
    expect(rows("Alpha")).toHaveLength(5);
    expect(
      button("Load more conversations in Alpha").querySelector(
        '[data-slot="badge"]'
      )?.textContent
    ).toContain("Load More");
    await act(async () => projectButton("Beta").click());
    // Opening one Project closes the one that was open.
    expect(rows("Alpha")).toHaveLength(0);
    expect(rows("Beta")).toHaveLength(5);
    await act(async () => projectButton("Alpha").click());
    expect(rows("Beta")).toHaveLength(0);
    expect(rows("Alpha")).toHaveLength(5);
    await act(async () => button("Load more conversations in Alpha").click());
    expect(rows("Alpha")).toHaveLength(10);
    await act(async () => button("Load more conversations in Alpha").click());
    expect(rows("Alpha")).toHaveLength(12);
    expect(button("Load more conversations in Alpha")).toBeNull();
    await act(async () => projectButton("Alpha").click());
    await act(async () => projectButton("Alpha").click());
    expect(rows("Alpha")).toHaveLength(5);
    await act(async () => button("Load more conversations in Alpha").click());
    await act(async () => root.render(<Harness scope="owner-b" data={data} />));
    expect(rows("Alpha")).toHaveLength(5);
  });

  it("searches older conversations and keeps the selected one visible without revealing all earlier rows", async () => {
    const data = [projectWithConversations("a", "Alpha", 12)];
    await act(async () => root.render(<Harness data={data} />));
    await searchFor("conversation 12");
    const matches = container.querySelectorAll<HTMLButtonElement>(
      ".v1-nav-projects .v1-nav-children .v1-nav-conversation"
    );
    expect(matches).toHaveLength(1);
    const older = matches[0]!;
    expect(older.textContent).toContain("Alpha conversation 12");
    await act(async () => older.click());
    await act(async () => button("Clear search").click());
    expect(
      container.querySelectorAll(".v1-nav-children .v1-nav-conversation")
    ).toHaveLength(6);
    expect(
      container.querySelector('[aria-current="page"]')?.textContent
    ).toContain("Alpha conversation 12");
    expect(button("Load more conversations in Alpha")).not.toBeNull();
    await act(async () => button("Go back").click());
    expect(
      container.querySelectorAll(".v1-nav-children .v1-nav-conversation")
    ).toHaveLength(5);
  });

  it("keeps Recall activity, Settings and Account in the persistent rail", async () => {
    window.koedDesktop = {
      account: {
        getState: async () => ({
          status: "signed_out",
          profile: null,
          busy: false,
          stale: false,
          message: null,
          revision: 0
        }),
        onStateChanged: () => () => undefined
      }
    } as unknown as NonNullable<typeof window.koedDesktop>;
    await act(async () => root.render(<Harness />));
    const actions = container.querySelectorAll(
      '.v1-nav-rail [data-slot="sidebar-footer"] button'
    );
    expect(
      [...actions].map((button) => button.getAttribute("aria-label"))
    ).toEqual(["Recall activity", "Settings", "Account menu: Account"]);
    await act(async () => button("Toggle navigation").click());
    expect(
      button("Account menu: Account").closest(".v1-nav-rail")
    ).not.toBeNull();
    delete window.koedDesktop;
  });

  it("keeps navigation usable without an account bridge or empty account rail item", async () => {
    await act(async () => root.render(<Harness />));
    expect(button("Account menu: Account")).toBeNull();
    expect(
      container.querySelectorAll('.v1-nav-rail [data-slot="sidebar-footer"] li')
    ).toHaveLength(2);
    await act(async () => button("Toggle navigation").click());
    expect(button("Settings")).not.toBeNull();
  });

  it("expands a Project Home reveals, so its open conversation shows", async () => {
    const second: SidebarProject = {
      id: "second",
      name: "Second",
      latestAt: "2026-10-28T12:00:00Z",
      conversations: [
        {
          key: "session:two",
          aliases: ["session:two"],
          title: "Opened from Home",
          client: "codex",
          latestAt: "2026-10-28T12:00:00Z",
          route: { kind: "conversation", projectId: "second", threadId: "two" },
          projectName: "Second"
        }
      ]
    };
    const data = [...projects, second];
    await act(async () => root.render(<Harness data={data} />));
    // Only the first Project starts expanded.
    const projectList = () =>
      container.querySelector(".v1-nav-projects")?.textContent ?? "";
    expect(projectList()).not.toContain("Opened from Home");
    await act(async () =>
      root.render(
        <Harness data={data} reveal={{ projectId: "second", key: 1 }} />
      )
    );
    expect(projectList()).toContain("Opened from Home");
  });

  it("distinguishes service startup, inventory loading and an empty inventory", async () => {
    await act(async () =>
      root.render(<Harness data={[]} inventoryReady={false} />)
    );
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain("Projects");
    await act(async () => root.render(<Harness data={[]} servicesStarting />));
    expect(container.textContent).toContain("Services starting…");
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain("Projects");
    await act(async () => root.render(<Harness data={[]} loading />));
    expect(container.textContent).toContain("Loading conversations…");
    expect(container.textContent).not.toContain("Services starting…");
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain("Projects");
    await act(async () => root.render(<Harness data={[]} />));
    expect(container.textContent).toContain("No conversations yet");
    expect(container.textContent).toContain("Projects");
    await act(async () => root.render(<Harness servicesStarting />));
    expect(container.textContent).toContain("Captured from Claude");
    expect(container.textContent).toContain("Services starting…");
  });
  it("persists pins across remounts, isolates owners, and supports unpinning", async () => {
    const pinned = () =>
      [...container.querySelectorAll(".v1-nav-projects .v1-nav-pin-mark")]
        .map((mark) => mark.closest("li")?.textContent)
        .join("|");
    await act(async () => root.render(<Harness />));
    await act(async () => button("Actions for Captured from Claude").click());
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "Pin")!
        .click()
    );
    expect(pinned()).toContain("Captured from Claude");
    await act(async () => root.render(<Harness scope="owner-b" />));
    expect(pinned()).not.toContain("Captured from Claude");
    await act(async () => root.render(<Harness scope="owner-a" />));
    expect(pinned()).toContain("Captured from Claude");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
    expect(pinned()).toContain("Captured from Claude");
    await act(async () => button("Actions for Captured from Claude").click());
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "Unpin")!
        .click()
    );
    expect(pinned()).not.toContain("Captured from Claude");
  });
  it("opens a capture directly, retains selection through ingestion, and supports history", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".v1-nav-conversation")!
        .click()
    );
    expect(
      container.querySelector('[data-testid="route"]')?.textContent
    ).toContain('"conversationKey":"session:one"');
    await act(async () =>
      root.render(
        <Harness
          data={[{ ...projects[0]!, latestAt: "2026-10-29T13:00:00Z" }]}
        />
      )
    );
    expect(
      container.querySelector("[aria-current=page]")?.textContent
    ).toContain("Captured from Claude");
    await act(async () => button("Go back").click());
    expect(container.querySelector('[data-testid="route"]')?.textContent).toBe(
      '{"kind":"home"}'
    );
    await act(async () => button("Go forward").click());
    expect(
      container.querySelector('[data-testid="route"]')?.textContent
    ).toContain('"conversationKey":"session:one"');
    await act(async () => root.render(<Harness scope="owner-b" />));
    expect(container.querySelector('[data-testid="route"]')?.textContent).toBe(
      '{"kind":"home"}'
    );
  });
});
