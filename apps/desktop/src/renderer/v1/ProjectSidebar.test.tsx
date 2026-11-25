// @vitest-environment happy-dom
import { act } from "react";
import { Storage } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationShell } from "./NavigationShell.js";
import { useNavigationHistory } from "./use-navigation-history.js";
import type { SidebarProject } from "./project-sidebar-model.js";
import type { SidebarManagement } from "./ProjectSidebar.js";

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
  management
}: {
  management?: SidebarManagement;
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
const pinnedSection = () => container.querySelector(".v1-nav-conversations")!;
const pinSectionText = () => pinnedSection().textContent ?? "";
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

  it("pins Projects in the Projects list and Conversations in both lists, per account/backend scope", async () => {
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
      [...pinnedSection().querySelectorAll("li")]
        .filter((row) => row.querySelector(".v1-nav-pin-mark"))
        .map((row) => row.querySelector(".v1-nav-copy > span")?.textContent);

    await render();
    expect(projectNames()).toEqual(["Koed", "Empty Project"]);
    expect(button("Actions for Project Koed")).toBeNull();
    await act(async () => button("Actions for Captured from Claude").click());
    await act(async () => menuItem("Pin").click());
    await act(async () => button("Actions for Project Empty Project")?.click());
    await act(async () => menuItem("Pin Project").click());
    // A pinned Conversation leads the Conversations list; a pinned Project
    // leads the Projects list and never joins the Conversations list.
    expect(pinnedTitles()).toEqual(["Captured from Claude"]);
    expect(pinSectionText()).not.toContain("Empty Project");
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

  it("lists No project Conversations only under Conversations", async () => {
    const noProject = projectWithConversations("no-project", "No project", 1);
    const named: SidebarProject = {
      ...projectWithConversations("named", "Koed", 1),
      managed: true
    };
    await act(async () => root.render(<Harness data={[named, noProject]} />));
    expect(
      [...container.querySelectorAll(".v1-nav-project")].map(
        (row) => row.textContent
      )
    ).toEqual(["Koed"]);
    expect(
      container.querySelector(".v1-nav-conversations")?.textContent
    ).toContain("No project conversation 1");
    expect(button("Actions for No project")).toBeNull();
  });

  it("highlights the open Conversation in the list it was opened from", async () => {
    await act(async () =>
      root.render(
        <Harness data={[projectWithConversations("a", "Alpha", 2)]} />
      )
    );
    const copies = () => ({
      list: container.querySelector<HTMLButtonElement>(
        ".v1-nav-conversations .v1-nav-conversation"
      )!,
      tree: container.querySelector<HTMLButtonElement>(
        ".v1-nav-projects .v1-nav-children .v1-nav-conversation"
      )!
    });
    await act(async () => copies().list.click());
    expect(copies().list.getAttribute("aria-current")).toBe("page");
    expect(copies().tree.getAttribute("aria-current")).toBeNull();
    expect(copies().tree.hasAttribute("data-also-open")).toBe(true);
    await act(async () => copies().tree.click());
    expect(copies().tree.getAttribute("aria-current")).toBe("page");
    expect(copies().list.hasAttribute("data-also-open")).toBe(true);
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
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
      "scratch"
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
    expect(section("Anchors")).toHaveLength(2);
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
    expect(count(".v1-nav-anchors")).toBe(15);
    await scrollToEnd(".v1-nav-anchors");
    expect(count(".v1-nav-anchors")).toBe(18);
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
    expect(
      container.querySelectorAll(".v1-nav-children .v1-nav-conversation")
    ).toHaveLength(1);
    const older = container.querySelector<HTMLButtonElement>(
      ".v1-nav-children .v1-nav-conversation"
    )!;
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
    expect(container.textContent).toContain("Conversations");
    await act(async () => root.render(<Harness data={[]} servicesStarting />));
    expect(container.textContent).toContain("Services starting…");
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain("Conversations");
    await act(async () => root.render(<Harness data={[]} loading />));
    expect(container.textContent).toContain("Loading conversations…");
    expect(container.textContent).not.toContain("Services starting…");
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain("Conversations");
    await act(async () => root.render(<Harness data={[]} />));
    expect(container.textContent).toContain("No conversations yet");
    expect(container.textContent).toContain("Conversations");
    await act(async () => root.render(<Harness servicesStarting />));
    expect(container.textContent).toContain("Captured from Claude");
    expect(container.textContent).toContain("Services starting…");
  });
  it("persists pins across remounts, isolates owners, and supports unpinning", async () => {
    const pinned = () =>
      [...container.querySelectorAll(".v1-nav-conversations .v1-nav-pin-mark")]
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
  it("scrolls Conversations on their own and loads more near the end", async () => {
    await act(async () =>
      root.render(
        <Harness data={[projectWithConversations("many", "Many", 30)]} />
      )
    );
    const area = container.querySelector(".v1-nav-conversations-scroll")!;
    const rows = () => area.querySelectorAll(".v1-nav-conversation").length;
    expect(rows()).toBe(20);
    expect(area.textContent).toContain("Loading more…");
    await act(async () => area.dispatchEvent(new Event("scroll")));
    expect(rows()).toBe(30);
    expect(area.textContent).not.toContain("Loading more…");
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
    ).toContain('"threadId":"one"');
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
    ).toContain('"threadId":"one"');
    await act(async () => root.render(<Harness scope="owner-b" />));
    expect(container.querySelector('[data-testid="route"]')?.textContent).toBe(
      '{"kind":"home"}'
    );
  });
});
