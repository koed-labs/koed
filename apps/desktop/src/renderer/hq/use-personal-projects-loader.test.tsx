// @vitest-environment happy-dom

import type {
  PersonalDesktopApi,
  PersonalDesktopProject
} from "@koed/shared/personal-desktop";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopProject } from "../../project-memory-ui.js";
import { PersonalMemoryStore } from "../state/personal-memory.js";
import { HqSidebar } from "./HqSidebar.js";
import { usePersonalProjectsLoader } from "./use-personal-projects-loader.js";

const actEnvironment = globalThis as {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const loadedProject: PersonalDesktopProject = {
  eventCount: 0,
  id: "ready-project",
  name: "Loaded after startup",
  path: "/workspace/ready-project",
  threads: []
};

const initialRoute = {
  kind: "workspace-channel",
  teamId: "team",
  workspaceId: "workspace",
  threadId: "thread"
} as const;
const nextRoute = {
  kind: "workspace-shared-memory",
  teamId: "team",
  workspaceId: "workspace"
} as const;

describe("HQ Personal Projects loading", () => {
  const containers: HTMLElement[] = [];
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    for (const container of containers.splice(0)) container.remove();
  });

  it("waits for startup readiness on an initial non-Personal route", async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const api: PersonalDesktopApi = {
      listProjects: vi.fn(async () => [loadedProject]),
      loadEventPage: vi.fn(async () => []),
      assignSessionProject: vi.fn(async () => ({ projectId: null })),
      updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
      updateSessionPresentation: vi.fn(async () => {
        throw new Error("not used in this test");
      }),
      subscribe: vi.fn(() => () => undefined)
    };
    const store = new PersonalMemoryStore(api);
    const container = document.createElement("div");
    containers.push(container);
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    const Probe = ({
      ready,
      route
    }: {
      ready: boolean;
      route: typeof initialRoute | typeof nextRoute;
    }) => {
      usePersonalProjectsLoader({
        hqEnabled: true,
        personalMemoryReady: ready,
        routeKind: route.kind,
        store
      });
      const snapshot = useSyncExternalStore(
        store.subscribe,
        store.current,
        store.current
      );
      const projects = snapshot.projectOrder
        .map((id) => snapshot.projectsById.get(id))
        .filter((project): project is DesktopProject => Boolean(project));

      return (
        <>
          <output data-testid="projects-loaded">
            {String(snapshot.projectsLoaded)}
          </output>
          <HqSidebar
            groupsReady={snapshot.projectsLoaded}
            loading={!snapshot.projectsLoaded}
            onOpenSearchAndCommands={() => undefined}
            onSelectConversation={() => undefined}
            onSelectProject={() => undefined}
            projects={projects}
            route={route}
          />
        </>
      );
    };

    await act(async () =>
      root.render(<Probe ready={false} route={initialRoute} />)
    );
    expect(api.listProjects).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="projects-loaded"]')?.textContent
    ).toBe("false");
    expect(
      container.querySelector('[data-hq-project-link="ready-project"]')
    ).toBeNull();

    await act(async () => root.render(<Probe ready route={initialRoute} />));
    expect(api.listProjects).toHaveBeenCalledOnce();
    expect(store.current().projectsLoaded).toBe(true);
    expect(
      container.querySelector('[data-hq-project-link="ready-project"]')
        ?.textContent
    ).toBe("Loaded after startup");

    await act(async () => root.render(<Probe ready route={nextRoute} />));
    expect(api.listProjects).toHaveBeenCalledOnce();
  });
});
