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
const pinnedSection = () => container.querySelector(".v1-nav-pinned")!;
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

  it("pins an empty named Project alongside a Conversation, jumps to it, and persists per account/backend scope", async () => {
    const data = [
      ...projects,
      {
        ...projectWithConversations("session:one", "Empty Project", 0),
        managed: true
      }
    ];
    const render = async (scope = "backend-a:owner-a") =>
      act(async () => root.render(<Harness data={data} scope={scope} />));
    const emptyProject = () =>
      [
        ...container.querySelectorAll<HTMLButtonElement>(".v1-nav-project")
      ].find((element) => element.textContent === "Empty Project")!;
    const pinnedTitles = () =>
      [...pinnedSection().querySelectorAll("li .v1-nav-copy > span")].map(
        (title) => title.textContent
      );

    await render();
    expect(button("Actions for Project Koed")).toBeNull();
    await act(async () => button("Actions for Captured from Claude").click());
    await act(async () => menuItem("Pin").click());
    await act(async () => button("Actions for Project Empty Project")?.click());
    expect(menuItem("Pin Project")).toBeDefined();
    await act(async () => menuItem("Pin Project").click());
    expect(pinnedTitles()).toEqual(["Captured from Claude", "Empty Project"]);
    expect(
      pinnedSection().querySelector(".v1-nav-heading small")?.textContent
    ).toBe("2");
    expect(
      window.localStorage.getItem("koed:sidebar-pins:backend-a:owner-a")
    ).toBe('["session:one","project:session:one"]');

    expect(emptyProject().getAttribute("aria-expanded")).toBe("false");
    await searchFor("Empty Project");
    expect(searchInput().placeholder).toBe("Find Projects or Conversations…");
    expect(pinnedTitles()).toEqual(["Empty Project"]);
    await act(async () =>
      button("Show Project Empty Project in Projects").click()
    );
    expect(searchInput().value).toBe("");
    expect(pinnedTitles()).toEqual(["Captured from Claude", "Empty Project"]);
    expect(emptyProject().getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".v1-nav-projects")?.textContent).toContain(
      "No conversations yet"
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(emptyProject()));
    expect(container.querySelector('[data-testid="route"]')?.textContent).toBe(
      '{"kind":"home"}'
    );
    await act(async () =>
      pinnedSection()
        .querySelector<HTMLButtonElement>(".v1-nav-conversation")!
        .click()
    );
    expect(
      container.querySelector('[data-testid="route"]')?.textContent
    ).toContain('"threadId":"one"');

    await render("backend-a:owner-b");
    expect(pinnedTitles()).toEqual([]);
    await render("backend-b:owner-a");
    expect(pinnedTitles()).toEqual([]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(pinnedTitles()).toEqual(["Captured from Claude", "Empty Project"]);

    await act(async () => button("Actions for Project Empty Project").click());
    await act(async () => menuItem("Unpin Project").click());
    expect(pinnedTitles()).toEqual(["Captured from Claude"]);
    expect(emptyProject()).toBeDefined();
    await act(async () => button("Actions for Project Empty Project").click());
    await act(async () => menuItem("Pin Project").click());
    await act(async () => button("Unpin Project Empty Project").click());
    expect(pinnedTitles()).toEqual(["Captured from Claude"]);
    expect(
      window.localStorage.getItem("koed:sidebar-pins:backend-a:owner-a")
    ).toBe('["session:one"]');
  });

  it("keeps keyboard focus on the Pinned heading after removing the last pin", async () => {
    window.localStorage.setItem(
      "koed:sidebar-pins:owner-a",
      '["project:empty"]'
    );
    await act(async () =>
      root.render(
        <Harness
          data={[
            { ...projectWithConversations("empty", "Empty", 0), managed: true }
          ]}
        />
      )
    );
    const unpin = button("Unpin Project Empty");
    unpin.focus();
    expect(document.activeElement).toBe(unpin);
    await act(async () => unpin.click());
    expect(button("Unpin Project Empty")).toBeNull();
    expect(document.activeElement).toBe(
      pinnedSection().querySelector(".v1-nav-heading")
    );
  });

  it("reveals conversations five at a time per Project and resets on collapse and owner changes", async () => {
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
    expect(rows("Beta")).toHaveLength(5);
    await act(async () => button("Load more conversations in Alpha").click());
    expect(rows("Alpha")).toHaveLength(10);
    expect(rows("Beta")).toHaveLength(5);
    await act(async () => button("Load more conversations in Alpha").click());
    expect(rows("Alpha")).toHaveLength(12);
    expect(button("Load more conversations in Alpha")).toBeNull();
    await act(async () => projectButton("Alpha").click());
    await act(async () => projectButton("Alpha").click());
    expect(rows("Alpha")).toHaveLength(5);
    await act(async () => button("Load more conversations in Alpha").click());
    await act(async () => button("Collapse all Projects").click());
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
    expect(container.textContent).not.toContain("Opened from Home");
    await act(async () =>
      root.render(
        <Harness data={data} reveal={{ projectId: "second", key: 1 }} />
      )
    );
    expect(container.textContent).toContain("Opened from Home");
  });

  it("distinguishes service startup, inventory loading and an empty inventory", async () => {
    await act(async () =>
      root.render(<Harness data={[]} inventoryReady={false} />)
    );
    const pinHint = "Pin Projects or Conversations to keep them here";
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain(pinHint);
    await act(async () => root.render(<Harness data={[]} servicesStarting />));
    expect(container.textContent).toContain("Services starting…");
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain(pinHint);
    await act(async () => root.render(<Harness data={[]} loading />));
    expect(container.textContent).toContain("Loading conversations…");
    expect(container.textContent).not.toContain("Services starting…");
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain(pinHint);
    await act(async () => root.render(<Harness data={[]} />));
    expect(container.textContent).toContain("No conversations yet");
    expect(container.textContent).toContain(pinHint);
    await act(async () => root.render(<Harness servicesStarting />));
    expect(container.textContent).toContain("Captured from Claude");
    expect(container.textContent).toContain("Services starting…");
  });
  it("persists pins across remounts, isolates owners, and supports unpinning", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => button("Actions for Captured from Claude").click());
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "Pin")!
        .click()
    );
    expect(container.querySelector(".v1-nav-pinned")?.textContent).toContain(
      "Captured from Claude"
    );
    await act(async () => root.render(<Harness scope="owner-b" />));
    expect(
      container.querySelector(".v1-nav-pinned")?.textContent
    ).not.toContain("Captured from Claude");
    await act(async () => root.render(<Harness scope="owner-a" />));
    expect(container.querySelector(".v1-nav-pinned")?.textContent).toContain(
      "Captured from Claude"
    );
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
    expect(container.querySelector(".v1-nav-pinned")?.textContent).toContain(
      "Captured from Claude"
    );
    await act(async () => button("Actions for Captured from Claude").click());
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "Unpin")!
        .click()
    );
    expect(
      container.querySelector(".v1-nav-pinned")?.textContent
    ).not.toContain("Captured from Claude");
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
