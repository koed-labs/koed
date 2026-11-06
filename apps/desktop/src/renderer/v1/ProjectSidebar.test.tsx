// @vitest-environment happy-dom
import { act } from "react";
import { Storage } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NavigationShell } from "./NavigationShell.js";
import { useNavigationHistory } from "./use-navigation-history.js";
import type { SidebarProject } from "./project-sidebar-model.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
function Harness({
  scope = "owner-a",
  data = projects,
  reveal = null,
  servicesStarting = false,
  loading = false,
  inventoryReady = true
}: {
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
      profileName="User"
      onHome={() => navigation.navigate({ kind: "home" })}
      onSettings={() => {}}
      onProfile={() => {}}
      onBack={navigation.back}
      onForward={navigation.forward}
      canGoBack={navigation.canGoBack}
      canGoForward={navigation.canGoForward}
      onRetry={() => {}}
    >
      <p data-testid="route">{JSON.stringify(navigation.route)}</p>
    </NavigationShell>
  );
}
let root: Root;
let container: HTMLDivElement;
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
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
});

describe("Project sidebar interactions", () => {
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
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain(
      "Pin conversations to keep them here"
    );
    await act(async () => root.render(<Harness data={[]} servicesStarting />));
    expect(container.textContent).toContain("Services starting…");
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain(
      "Pin conversations to keep them here"
    );
    await act(async () => root.render(<Harness data={[]} loading />));
    expect(container.textContent).toContain("Loading conversations…");
    expect(container.textContent).not.toContain("Services starting…");
    expect(container.textContent).not.toContain("No conversations yet");
    expect(container.textContent).toContain(
      "Pin conversations to keep them here"
    );
    await act(async () => root.render(<Harness data={[]} />));
    expect(container.textContent).toContain("No conversations yet");
    expect(container.textContent).toContain(
      "Pin conversations to keep them here"
    );
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
