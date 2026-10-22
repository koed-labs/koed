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
import { HqProjectView, workItemOriginConversation } from "./HqProjectView.js";
import { dueChoiceDate } from "../due/hq-due-model.js";
import { viewerTimeZone } from "./hq-work-item-model.js";

describe("Project HQ Work Item writes", () => {
  it("resolves same and cross Project source chats without exposing stale or ambiguous IDs", () => {
    const item = {
      origin: "koed_text_action",
      originRef: sessionId,
      projectId: personalId
    } as WorkItem;
    const duplicate = {
      id: anotherPersonalId,
      name: "Other graph",
      threads: [
        {
          id: "cross-thread",
          sessionId,
          personalProjectId: anotherPersonalId,
          name: "Other source"
        }
      ]
    } as DesktopProject;
    expect(
      workItemOriginConversation(item, [duplicate, ...graphProjects])?.thread.id
    ).toBe("thread-one");
    expect(workItemOriginConversation(item, [duplicate])?.thread.id).toBe(
      "cross-thread"
    );
    expect(
      workItemOriginConversation(item, [
        duplicate,
        {
          ...duplicate,
          id: "third-graph",
          threads: [{ ...duplicate.threads[0]!, id: "third-thread" }]
        }
      ])
    ).toBeNull();
    expect(
      workItemOriginConversation(
        { ...item, originRef: "missing" },
        graphProjects
      )
    ).toBeNull();
    expect(
      workItemOriginConversation({ ...item, originRef: null }, graphProjects)
    ).toBeNull();
  });
  it("shows a keyless Conversation-origin item, opens its source chat, and closes the brief", async () => {
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
      id: "00000000-0000-4000-8000-000000002074",
      projectId: personalId,
      kind: "todo",
      key: null,
      title: "Check mobile spacing",
      goal: "Polish the narrow layout requested in chat",
      origin: "koed_text_action",
      originRef: sessionId,
      status: "doing",
      executionId: null,
      assigneeAgentId: null,
      version: 1,
      dueOn: null,
      createdAt: "2026-10-20T00:00:00Z",
      updatedAt: "2026-10-20T00:00:00Z"
    } as WorkItem;
    const api = {
      hq: vi.fn(async () => ({ project, activity: null })),
      workItemList: vi.fn(async () => [item]),
      sourceList: vi.fn(async () => [])
    } as unknown as ProjectsDesktopApi;
    const selectConversation = vi.fn();
    try {
      await act(async () =>
        root.render(
          <HqProjectView
            project={project}
            personalProjects={[project]}
            graphProjects={[
              {
                id: graphId,
                name: "Koed",
                threads: [
                  { id: "thread-one", sessionId, name: "Mobile review" }
                ]
              } as DesktopProject
            ]}
            projectsApi={api}
            ownerId="owner"
            profileKey="profile"
            panelHost={node}
            onSelectConversation={selectConversation}
          />
        )
      );
      expect(
        node.querySelector(".hq-project-view__origin-summary")?.textContent
      ).toContain("From Mobile review · Polish the narrow layout");
      await act(async () =>
        node
          .querySelector<HTMLButtonElement>(
            ".hq-project-view__section--doing .hq-project-view__brief-trigger"
          )!
          .click()
      );
      expect(node.querySelector('[aria-label="Work brief"]')).toBeTruthy();
      await act(async () =>
        node
          .querySelector<HTMLButtonElement>('[aria-label="Close work brief"]')!
          .click()
      );
      expect(node.querySelector('[aria-label="Work brief"]')).toBeNull();
      await act(async () =>
        node
          .querySelector<HTMLButtonElement>(
            ".hq-project-view__section--doing .hq-project-view__brief-trigger"
          )!
          .click()
      );
      await act(async () =>
        node
          .querySelector<HTMLButtonElement>(".hq-project-view__origin-link")!
          .click()
      );
      expect(selectConversation).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId, threadId: "thread-one" })
      );
      expect(selectConversation.mock.calls[0]?.[0]).not.toHaveProperty(
        "executionId"
      );
      expect(node.querySelector('[aria-label="Work brief"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });
  it("opens the Due menu by right-click and saves a viewer-local calendar date", async () => {
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
    const todo = {
      id: "todo-due",
      projectId: personalId,
      title: "Review slides",
      status: "todo",
      version: 1,
      dueOn: null,
      createdAt: "2026-10-20T00:00:00Z",
      updatedAt: "2026-10-20T00:00:00Z"
    } as WorkItem;
    const patch = vi.fn(
      async (
        _projectId: string,
        _itemId: string,
        value: { dueOn?: string | null }
      ) => ({ ...todo, dueOn: value.dueOn ?? null, version: 2 })
    );
    const api = {
      hq: vi.fn(async () => ({ project, activity: null })),
      workItemList: vi.fn(async () => [todo]),
      workItemPatch: patch,
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
      const row = node.querySelector(
        ".hq-project-view__section--todo .hq-project-view__work-item"
      )!;
      expect(
        row.querySelector(".hq-project-view__work-item-meta > .hq-due")
      ).toBeNull();
      await act(async () =>
        row.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
        )
      );
      expect(row.querySelector('[role="menu"]')).toBeTruthy();
      const expected = dueChoiceDate("friday", viewerTimeZone(), new Date());
      await act(async () =>
        Array.from(row.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
          .find((button) => button.textContent === "Friday")!
          .click()
      );
      expect(patch).toHaveBeenCalledWith(personalId, todo.id, {
        version: 1,
        dueOn: expected
      });
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });
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
