// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceProjectState,
  WorkspaceProjectWorkItemCreate,
  WorkspaceProjectWorkItemPatch
} from "@koed/shared";
import { SharedProjectPanel } from "./SharedProjectPanel.js";
import { SharedProjectStore } from "./shared-project-store.js";

const identity = {
  ownerId: "owner-1",
  profileKey: "profile-1",
  personalProjectId: "personal-1",
  workspaceProjectId: "workspace-1",
  teamBackendId: "backend-1"
};
const state = (title: string, readOnly = false): WorkspaceProjectState => ({
  project: {
    id: "workspace-1",
    teamId: "team-1",
    workspaceId: "team-workspace-1",
    ownerTeamMemberId: "member-1",
    name: "Shared plan",
    key: "PLAN",
    lifecycle: "active",
    version: 1,
    copiedAt: null
  },
  memberVersion: 1,
  activity: null,
  workItems: [
    {
      id: "item-1",
      sourceOwnerTeamMemberId: "member-1",
      sourceWorkItemId: null,
      kind: "todo",
      key: null,
      title,
      goal: title,
      status: "todo",
      dueOn: null,
      assigneeDisplayName: null,
      stepLabel: null,
      doneAt: null,
      dispatchKey: null,
      createdAt: "2026-10-20T09:00:00.000Z",
      updatedAt: "2026-10-20T09:00:00.000Z",
      prUrl: null,
      prState: null,
      version: title === "Teammate title" ? 2 : 1
    }
  ],
  sources: [
    {
      id: "source-1",
      uploaderTeamMemberId: "member-1",
      sourceProjectSourceId: "source-1",
      name: "Plan.md",
      kind: "doc",
      status: "ready",
      personalNoteId: null,
      personalNoteRevisionId: null,
      version: 1
    }
  ],
  readOnly,
  notice: readOnly ? "Offline. Shared changes are paused." : null
});

describe("SharedProjectPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("keeps the local title draft after a Team version conflict", async () => {
    const patch = vi.fn(async () => ({
      status: "conflict" as const,
      state: state("Teammate title")
    }));
    const store = new SharedProjectStore({
      sharedRefresh: vi.fn(async () => state("Original title")),
      sharedPatchWorkItem: patch
    });
    await act(async () =>
      root.render(
        <SharedProjectPanel
          store={store}
          identity={identity}
          refreshSignal={0}
          agents={[]}
        />
      )
    );
    await act(async () =>
      (
        container.querySelector(
          '[aria-label="Edit Original title"]'
        ) as HTMLButtonElement
      ).click()
    );
    const input = container.querySelector(
      'input[aria-label="Edit Original title"]'
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "My title");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      (
        container.querySelector(
          '.hq-shared-project__row button[type="submit"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(patch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Teammate title");
    expect(
      (
        container.querySelector(
          'input[aria-label="Edit Teammate title"]'
        ) as HTMLInputElement
      ).value
    ).toBe("My title");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Your edit is kept"
    );
  });

  it("shows cached shared rows and prevents offline writes", async () => {
    const patch = vi.fn();
    const store = new SharedProjectStore({
      sharedRefresh: vi.fn(async () => state("Cached title", true)),
      sharedPatchWorkItem: patch
    });
    await act(async () =>
      root.render(
        <SharedProjectPanel
          store={store}
          identity={identity}
          refreshSignal={0}
          agents={[]}
        />
      )
    );
    expect(container.textContent).toContain("Cached title");
    expect(container.textContent).toContain(
      "Offline. Shared changes are paused."
    );
    expect(
      (
        container.querySelector(
          '[aria-label="Tick off Cached title"]'
        ) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps online view-only Team members out of the editor", async () => {
    const patch = vi.fn();
    const store = new SharedProjectStore({
      sharedRefresh: vi.fn(async () => ({
        ...state("View-only title"),
        readOnly: true,
        notice: "You can view this shared Project. Editing is unavailable."
      })),
      sharedPatchWorkItem: patch
    });
    await act(async () =>
      root.render(
        <SharedProjectPanel
          store={store}
          identity={identity}
          refreshSignal={0}
          agents={[]}
        />
      )
    );
    expect(container.textContent).toContain("View-only title");
    expect(container.textContent).toContain("Editing is unavailable.");
    expect(
      (
        container.querySelector(
          '[aria-label="Edit View-only title"]'
        ) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("saves a shared Due choice with Team item version and keeps it for a 409 retry", async () => {
    let calls = 0;
    const patch = vi.fn(
      async (
        _projectId: string,
        _backendId: string,
        _itemId: string,
        value: WorkspaceProjectWorkItemPatch
      ) =>
        ++calls === 1
          ? { status: "conflict" as const, state: state("Teammate title") }
          : {
              status: "ok" as const,
              item: {
                ...state("Teammate title").workItems[0]!,
                dueOn: value.dueOn ?? null,
                version: 3
              }
            }
    );
    const store = new SharedProjectStore({
      sharedRefresh: vi.fn(async () => state("Original title")),
      sharedPatchWorkItem: patch
    });
    await act(async () =>
      root.render(
        <SharedProjectPanel
          store={store}
          identity={identity}
          refreshSignal={0}
          agents={[]}
        />
      )
    );
    const row = container.querySelector(".hq-shared-project__row")!;
    expect(
      row.querySelector(".hq-project-view__work-item-meta > .hq-due")
    ).toBeNull();
    await act(async () =>
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true
        })
      )
    );
    expect(
      container.querySelector(
        '[role="menu"][aria-label="Due date for Original title"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector('input[aria-label="Edit Original title"]')
    ).toBeNull();
    await act(async () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      )
        .find((button) => button.textContent === "Friday")!
        .click()
    );
    expect(patch.mock.calls[0]?.[3]).toMatchObject({
      expectedVersion: 1,
      dueOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    });
    expect(container.textContent).toContain("Teammate title");
    expect(container.textContent).toContain("Due date not saved.");
    await act(async () =>
      (
        container.querySelector(
          ".hq-shared-project__due-conflict button"
        ) as HTMLButtonElement
      ).click()
    );
    expect(patch.mock.calls[1]?.[3]).toEqual({
      expectedVersion: 2,
      dueOn: patch.mock.calls[0]![3].dueOn
    });
    expect(
      container.querySelector(".hq-shared-project__due-conflict")
    ).toBeNull();
  });

  it("does not intercept Due context events on completed shared items", async () => {
    const complete = state("Completed task");
    complete.workItems[0] = {
      ...complete.workItems[0]!,
      status: "done",
      doneAt: new Date().toISOString()
    };
    const store = new SharedProjectStore({
      sharedRefresh: vi.fn(async () => complete)
    });
    await act(async () =>
      root.render(
        <SharedProjectPanel
          store={store}
          identity={identity}
          refreshSignal={0}
          agents={[]}
        />
      )
    );
    const row = container.querySelector(".hq-shared-project__row")!;
    for (const event of [
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", {
        key: "ContextMenu",
        bubbles: true,
        cancelable: true
      }),
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    ]) {
      await act(async () => {
        row.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(
        container.querySelector('[role="menu"][aria-label^="Due date"]')
      ).toBeNull();
    }
  });

  it("disables Due changes for an offline viewer and focuses an exact Team row", async () => {
    const patch = vi.fn();
    const handled = vi.fn();
    const store = new SharedProjectStore({
      sharedRefresh: vi.fn(async () => {
        const offline = state("Team deadline", true);
        offline.workItems[0]!.dueOn = "2026-10-23";
        return offline;
      }),
      sharedPatchWorkItem: patch
    });
    await act(async () =>
      root.render(
        <SharedProjectPanel
          store={store}
          identity={identity}
          refreshSignal={0}
          agents={[]}
          focusWorkItemId="item-1"
          onFocusWorkItemHandled={handled}
        />
      )
    );
    const row = container.querySelector<HTMLElement>(
      '[data-shared-work-item-id="item-1"]'
    )!;
    expect(
      (row.querySelector(".hq-due__trigger") as HTMLButtonElement).disabled
    ).toBe(true);
    await act(async () =>
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true
        })
      )
    );
    expect(
      container.querySelector('[role="menu"][aria-label^="Due date"]')
    ).toBeNull();
    expect(patch).not.toHaveBeenCalled();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(document.activeElement).toBe(row);
    expect(handled).toHaveBeenCalled();
  });

  it("parses a viewer-local due date and keeps the v50 leading to-do tick", async () => {
    const create = vi.fn(
      async (
        _projectId: string,
        _backendId: string,
        value: WorkspaceProjectWorkItemCreate
      ) => ({
        status: "ok" as const,
        item: {
          ...state(value.title).workItems[0]!,
          ...value,
          id: "new-item",
          version: 1
        }
      })
    );
    const patch = vi.fn(
      async (
        _projectId: string,
        _backendId: string,
        _itemId: string,
        value: WorkspaceProjectWorkItemPatch
      ) => ({
        status: "ok" as const,
        item: {
          ...state("Original title").workItems[0]!,
          ...value,
          status: "done" as const
        }
      })
    );
    const store = new SharedProjectStore({
      sharedRefresh: vi.fn(async () => state("Original title")),
      sharedCreateWorkItem: create,
      sharedPatchWorkItem: patch
    });
    await act(async () =>
      root.render(
        <SharedProjectPanel
          store={store}
          identity={identity}
          refreshSignal={0}
          agents={[]}
        />
      )
    );
    const row = container.querySelector(
      ".hq-project-view__section--todo .hq-shared-project__row"
    )!;
    expect(row.firstElementChild?.getAttribute("aria-label")).toBe(
      "Tick off Original title"
    );
    const input = container.querySelector(
      'input[aria-label="New shared to-do"]'
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "Send report by Friday");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      (
        container.querySelector(
          'button[aria-label="Add shared to-do"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(create.mock.calls[0]?.[2]).toMatchObject({
      title: "Send report",
      dueOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    });
    await act(async () =>
      (
        row.querySelector(
          'button[aria-label="Tick off Original title"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(patch.mock.calls[0]?.[3]).toMatchObject({
      expectedVersion: 1,
      status: "done"
    });
  });

  it("caps rows and counts Done today in the viewer's calendar", async () => {
    const base = state("First to-do");
    const seven = Array.from({ length: 7 }, (_, index) => ({
      ...base.workItems[0]!,
      id: `todo-${index}`,
      title: `To-do ${index}`
    }));
    const done = {
      ...base.workItems[0]!,
      id: "done-today",
      title: "Done today",
      status: "done" as const,
      doneAt: new Date().toISOString()
    };
    const old = {
      ...done,
      id: "done-old",
      title: "Old completion",
      doneAt: "2020-01-01T12:00:00.000Z"
    };
    const store = new SharedProjectStore({
      sharedRefresh: async () => ({ ...base, workItems: [...seven, done, old] })
    });
    await act(async () =>
      root.render(
        <SharedProjectPanel
          store={store}
          identity={identity}
          refreshSignal={0}
          agents={[]}
        />
      )
    );
    expect(
      container.querySelectorAll(
        ".hq-project-view__section--todo .hq-shared-project__row"
      )
    ).toHaveLength(5);
    expect(
      container.querySelector(
        ".hq-project-view__section--todo .hq-project-view__section-head"
      )?.textContent
    ).toContain("7");
    expect(
      container.querySelectorAll(
        ".hq-project-view__section--done .hq-shared-project__row"
      )
    ).toHaveLength(1);
    expect(container.textContent).not.toContain("Old completion");
    await act(async () =>
      (
        container.querySelector(
          ".hq-project-view__section--todo .hq-project-view__more"
        ) as HTMLButtonElement
      ).click()
    );
    expect(
      container.querySelectorAll(
        ".hq-project-view__section--todo .hq-shared-project__row"
      )
    ).toHaveLength(7);
  });
});
