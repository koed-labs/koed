import { describe, expect, it } from "vitest";
import type { Project } from "@koed/shared";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { projectHqExecutionBelongsTo } from "./HqProjectView.js";

const personalId = "00000000-0000-4000-8000-000000002071";
const anotherPersonalId = "00000000-0000-4000-8000-000000002072";
const graphId = "graph-koed";
const sessionId = "00000000-0000-4000-8000-000000002073";
const projects = [
  { id: personalId, name: "Koed" },
  { id: anotherPersonalId, name: "Other" }
] as Project[];
const graphProjects = [
  {
    id: graphId,
    threads: [
      { id: "thread-one", sessionId, personalProjectId: personalId },
      {
        id: "thread-two",
        sessionId: "other-session",
        personalProjectId: anotherPersonalId
      }
    ]
  }
] as DesktopProject[];

describe("Project HQ runtime identity", () => {
  it("accepts the canonical Personal Project ID and only captured sessions linked to that Project", () => {
    const entry = {
      executionId: "run",
      projectId: graphId,
      sessionId,
      threadId: "thread-one",
      state: "running"
    };
    expect(
      projectHqExecutionBelongsTo(entry, personalId, projects, graphProjects)
    ).toBe(true);
    expect(
      projectHqExecutionBelongsTo(
        entry,
        anotherPersonalId,
        projects,
        graphProjects
      )
    ).toBe(false);
    expect(
      projectHqExecutionBelongsTo(
        { ...entry, sessionId: "unknown" },
        personalId,
        projects,
        graphProjects
      )
    ).toBe(false);
    expect(
      projectHqExecutionBelongsTo(
        { ...entry, projectId: anotherPersonalId },
        personalId,
        projects,
        graphProjects
      )
    ).toBe(false);
    expect(
      projectHqExecutionBelongsTo(
        { ...entry, projectId: personalId, sessionId: null },
        personalId,
        projects,
        graphProjects
      )
    ).toBe(true);
  });
});
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import type { ProjectsDesktopApi } from "../../../ipc/projects-protocol.js";
import type { WorkItem } from "@koed/shared/work-item-contract";
import { HqProjectView } from "./HqProjectView.js";

describe("Project HQ Work Item writes", () => {
  it("ignores a late creation after owner changes on the same Project", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    let resolveCreate!: (item: WorkItem) => void;
    const create = vi.fn(
      () =>
        new Promise<WorkItem>((resolve) => {
          resolveCreate = resolve;
        })
    );
    const project = {
      id: personalId,
      name: "Koed",
      lifecycle: "active",
      folderPath: null
    } as Project;
    const api = {
      hq: vi.fn(async () => ({ project, activity: null })),
      workItemList: vi.fn(async () => []),
      workItemCreate: create,
      sourceList: vi.fn(async () => [])
    } as unknown as ProjectsDesktopApi;
    const view = (ownerId: string) => (
      <HqProjectView
        project={project}
        personalProjects={[project]}
        graphProjects={[]}
        projectsApi={api}
        ownerId={ownerId}
        profileKey={ownerId}
        onSelectConversation={() => undefined}
      />
    );
    await act(async () => root.render(view("owner-a")));
    const input = node.querySelector<HTMLInputElement>(
      '[aria-label="Add a to-do"]'
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!;
      setter.call(input, "Review slides by Friday");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      node.querySelector<HTMLButtonElement>('[aria-label="Add to-do"]')!.click()
    );
    expect(create).toHaveBeenCalledOnce();
    await act(async () => root.render(view("owner-b")));
    await act(async () =>
      resolveCreate({
        id: "00000000-0000-4000-8000-000000004099",
        title: "Review slides",
        projectId: personalId
      } as WorkItem)
    );
    expect(node.textContent).not.toContain("Review slides");
    expect(
      node.querySelector<HTMLInputElement>('[aria-label="Add a to-do"]')?.value
    ).toBe("");
    await act(async () => root.unmount());
    node.remove();
  });
  it("reuses the exact creation key after a lost acknowledgement", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const project = {
      id: personalId,
      name: "Koed",
      lifecycle: "active",
      folderPath: null
    } as Project;
    const create = vi.fn().mockRejectedValue(new Error("connection lost"));
    const api = {
      hq: vi.fn(async () => ({ project, activity: null })),
      workItemList: vi.fn(async () => []),
      workItemCreate: create,
      sourceList: vi.fn(async () => [])
    } as unknown as ProjectsDesktopApi;
    await act(async () =>
      root.render(
        <HqProjectView
          project={project}
          personalProjects={[project]}
          graphProjects={[]}
          projectsApi={api}
          ownerId="owner-a"
          profileKey="profile-a"
          onSelectConversation={() => undefined}
        />
      )
    );
    const input = node.querySelector<HTMLInputElement>(
      '[aria-label="Add a to-do"]'
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, "Review slides by Friday");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      node.querySelector<HTMLButtonElement>('[aria-label="Add to-do"]')!.click()
    );
    await act(async () =>
      node.querySelector<HTMLButtonElement>('[aria-label="Add to-do"]')!.click()
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.mock.calls[1]?.[1].idempotencyKey).toBe(
      create.mock.calls[0]?.[1].idempotencyKey
    );
    await act(async () => root.unmount());
    node.remove();
  });
  it("ignores a late completion after the profile changes", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const project = {
      id: personalId,
      name: "Koed",
      lifecycle: "active",
      folderPath: null
    } as Project;
    const todo = {
      id: "00000000-0000-4000-8000-000000004098",
      projectId: personalId,
      title: "Review slides",
      status: "todo",
      version: 1,
      dueOn: null,
      createdAt: "2026-10-20T00:00:00Z",
      updatedAt: "2026-10-20T00:00:00Z"
    } as WorkItem;
    let resolvePatch!: (item: WorkItem) => void;
    const patch = vi.fn(
      () =>
        new Promise<WorkItem>((resolve) => {
          resolvePatch = resolve;
        })
    );
    const api = {
      hq: vi.fn(async () => ({ project, activity: null })),
      workItemList: vi.fn(async () => [todo]),
      workItemPatch: patch,
      sourceList: vi.fn(async () => [])
    } as unknown as ProjectsDesktopApi;
    const view = (profileKey: string) => (
      <HqProjectView
        project={project}
        personalProjects={[project]}
        graphProjects={[]}
        projectsApi={api}
        ownerId="owner-a"
        profileKey={profileKey}
        onSelectConversation={() => undefined}
      />
    );
    await act(async () => root.render(view("profile-a")));
    await act(async () =>
      node
        .querySelector<HTMLButtonElement>(
          '[aria-label="Tick off Review slides"]'
        )!
        .click()
    );
    await act(async () => root.render(view("profile-b")));
    await act(async () =>
      resolvePatch({
        ...todo,
        status: "done",
        doneAt: new Date().toISOString(),
        version: 2
      })
    );
    expect(
      node.querySelector('[aria-label="Done today"]')?.textContent
    ).not.toContain("Review slides");
    await act(async () => root.unmount());
    node.remove();
  });
});

describe("Project HQ unavailable provider review", () => {
  it("keeps an existing PR Work Item visible and counted when provider discovery is unavailable", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    const project = {
      id: personalId,
      name: "Koed",
      lifecycle: "active"
    } as Project;
    const item = {
      id: "review-a",
      projectId: personalId,
      title: "Review without provider connection",
      status: "review",
      prNumber: 17,
      prUrl: "https://github.com/koed-labs/koed/pull/17",
      prProvider: "github",
      prState: "open",
      updatedAt: new Date().toISOString()
    } as WorkItem;
    const api = {
      hq: vi.fn(async () => ({ project, activity: null })),
      workItemList: vi.fn(async () => [item]),
      sourceList: vi.fn(async () => [])
    } as unknown as ProjectsDesktopApi;
    try {
      await act(async () =>
        root.render(
          <HqProjectView
            project={project}
            personalProjects={[project]}
            graphProjects={[]}
            projectsApi={api}
            ownerId="owner"
            profileKey="profile"
            onSelectConversation={() => undefined}
          />
        )
      );
      const section = node.querySelector('[aria-label="In review"]');
      expect(
        section?.querySelector(".hq-project-view__section-head span")
          ?.textContent
      ).toBe("1");
      expect(section?.textContent).toContain(item.title);
      expect(section?.querySelector("a")?.textContent).toBe("Open on GitHub");
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });
});
