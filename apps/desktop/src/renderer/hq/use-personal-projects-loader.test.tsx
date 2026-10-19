// @vitest-environment happy-dom

import type {
  PersonalDesktopApi,
  PersonalDesktopProject
} from "@koed/shared/personal-desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PersonalMemoryStore } from "../state/personal-memory.js";
import { HqApplication } from "./HqApplication.js";

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

describe("HQ Personal Projects loading", () => {
  const containers: HTMLElement[] = [];
  const roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    for (const container of containers.splice(0)) container.remove();
  });

  it("owns one readiness-gated HQ load across destination selection", async () => {
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

    await act(async () =>
      root.render(
        <HqApplication
          personalMemoryReady={false}
          personalMemoryStore={store}
        />
      )
    );
    expect(api.listProjects).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-hq-project-link="ready-project"]')
    ).toBeNull();

    await act(async () =>
      root.render(
        <HqApplication personalMemoryReady personalMemoryStore={store} />
      )
    );
    expect(api.listProjects).toHaveBeenCalledOnce();
    expect(store.current().projectsLoaded).toBe(true);
    expect(
      container.querySelector('[data-hq-project-link="ready-project"]')
        ?.textContent
    ).toBe("Loaded after startup");

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-hq-project-link="ready-project"]'
        )
        ?.click()
    );
    expect(
      container
        .querySelector('[data-hq-route="project"]')
        ?.getAttribute("data-hq-project-id")
    ).toBe("ready-project");
    expect(container.querySelector("[data-personal-route-focus]")).toBeNull();
    expect(api.loadEventPage).not.toHaveBeenCalled();
    expect(api.listProjects).toHaveBeenCalledOnce();

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Search and commands"]'
        )
        ?.click()
    );
    const search = document.querySelector<HTMLInputElement>(".hq-search input");
    expect(search).not.toBeNull();
    expect(document.querySelector(".hq-search")?.textContent).not.toContain(
      "Preferences"
    );
    expect(document.querySelector(".hq-search")?.textContent).not.toContain(
      "Devices"
    );
    expect(document.querySelector(".hq-search")?.textContent).not.toContain(
      "Settings"
    );
    await act(async () =>
      search?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    );
    expect(
      container
        .querySelector('[data-hq-route="project"]')
        ?.getAttribute("data-hq-project-id")
    ).toBe("ready-project");
    expect(document.querySelector(".hq-search")).toBeNull();
    expect(api.loadEventPage).not.toHaveBeenCalled();
    const command = async (label: string) => {
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Search and commands"]'
          )
          ?.click()
      );
      const option = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '.hq-search [role="option"]'
        )
      ].find((item) => item.querySelector("span")?.textContent === label);
      expect(option).toBeDefined();
      await act(async () => option?.click());
    };
    await command("Toggle context panel");
    expect(container.querySelector("[data-hq-context]")).toBeNull();
    await command("Toggle sidebar");
    expect(
      container
        .querySelector("[data-hq-shell]")
        ?.hasAttribute("data-hq-compact")
    ).toBe(true);
    await command("Toggle sidebar");
    expect(
      container
        .querySelector("[data-hq-shell]")
        ?.hasAttribute("data-hq-compact")
    ).toBe(false);
    expect(
      container
        .querySelector('[data-hq-route="project"]')
        ?.getAttribute("data-hq-project-id")
    ).toBe("ready-project");
    expect(api.listProjects).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    "offers Retry after metadata failure with graph rows=%s",
    async (hasRows) => {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
      let failMetadata = true;
      const api: PersonalDesktopApi = {
        listProjects: vi.fn(async () => (hasRows ? [loadedProject] : [])),
        listProjectMetadata: vi.fn(async () => {
          if (failMetadata) throw new Error("metadata unavailable");
          return [];
        }),
        loadEventPage: vi.fn(async () => []),
        assignSessionProject: vi.fn(async () => ({ projectId: null })),
        updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
        updateSessionPresentation: vi.fn(async () => {
          throw new Error("unused");
        }),
        subscribe: () => () => undefined
      };
      const store = new PersonalMemoryStore(api);
      const container = document.createElement("div");
      containers.push(container);
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await act(async () =>
        root.render(
          <HqApplication personalMemoryReady personalMemoryStore={store} />
        )
      );
      expect(
        container.querySelector("[data-hq-project-load-error]")
      ).not.toBeNull();
      expect(container.textContent).not.toContain("Loading Projects");
      expect(container.textContent).not.toContain("No Projects or Chats yet");
      expect(
        Boolean(
          container.querySelector('[data-hq-project-link="ready-project"]')
        )
      ).toBe(hasRows);
      expect(store.current().projectsLoaded).toBe(false);
      failMetadata = false;
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>("[data-hq-project-retry]")
          ?.click()
      );
      expect(store.current().projectsLoaded).toBe(true);
      expect(
        container.querySelector("[data-hq-project-load-error]")
      ).toBeNull();
      expect(container.textContent?.includes("No Projects or Chats yet")).toBe(
        !hasRows
      );
      expect(api.listProjects).toHaveBeenCalledTimes(2);
    }
  );
});
