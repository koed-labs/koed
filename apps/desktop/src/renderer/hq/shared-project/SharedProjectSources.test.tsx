// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceProjectSource,
  WorkspaceProjectState
} from "@koed/shared";
import { SharedProjectSources } from "./SharedProjectSources.js";
import { SharedProjectStore } from "./shared-project-store.js";

const identity = {
  ownerId: "owner",
  profileKey: "profile",
  personalProjectId: "personal",
  workspaceProjectId: "workspace",
  teamBackendId: "backend"
};
const source: WorkspaceProjectSource = {
  id: "source",
  uploaderTeamMemberId: "member",
  sourceProjectSourceId: "personal-source",
  name: "Plan.md",
  kind: "doc",
  status: "ready",
  personalNoteId: null,
  personalNoteRevisionId: null,
  version: 1
};
const state = (
  sources: WorkspaceProjectSource[],
  readOnly = false
): WorkspaceProjectState => ({
  project: {
    id: identity.workspaceProjectId,
    teamId: "team",
    workspaceId: "team-workspace",
    ownerTeamMemberId: "member",
    name: "Shared plan",
    key: "PLAN",
    lifecycle: "active",
    version: 2,
    copiedAt: null
  },
  memberVersion: 1,
  activity: null,
  workItems: [],
  sources,
  readOnly,
  notice: null
});

describe("Shared Project Sources", () => {
  let container: HTMLDivElement;
  let panelHost: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    panelHost = document.createElement("div");
    document.body.append(container, panelHost);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    panelHost.remove();
    vi.restoreAllMocks();
  });
  it("renames, removes through reviewed Step-up, and restores through versioned Team Source actions", async () => {
    let sources = [source];
    const patch = vi.fn(
      async (
        _projectId: string,
        _backendId: string,
        _id: string,
        value: { expectedVersion: number; name?: string; deleted?: boolean }
      ) => {
        const next = {
          ...source,
          name: value.name ?? source.name,
          version: value.expectedVersion + 1
        };
        sources = value.deleted ? [] : [next];
        return next;
      }
    );
    const store = new SharedProjectStore({
      sharedRefresh: async () => state(sources),
      sharedPatchSource: patch
    });
    const deleteSource = vi.fn(async () => {
      sources = [];
      return {
        projectId: "workspace",
        sourceId: "source",
        version: 3,
        deleted: true as const
      };
    });
    await act(async () => store.setIdentity(identity));
    await act(async () =>
      root.render(
        <SharedProjectSources
          store={store}
          identity={identity}
          panelHost={panelHost}
          deleteSource={deleteSource}
        />
      )
    );
    await act(async () =>
      (
        container.querySelector(
          ".hq-project-sources__count"
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      (
        panelHost.querySelector(".hq-project-sources__row") as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      Array.from(panelHost.querySelectorAll("button"))
        .find((button) => button.textContent === "Rename")!
        .click()
    );
    const input = panelHost.querySelector(
      'input[aria-label="Source name"]'
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "Updated.md");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      (
        panelHost.querySelector('button[type="submit"]') as HTMLButtonElement
      ).click()
    );
    expect(patch.mock.calls[0]?.[3]).toMatchObject({
      expectedVersion: 1,
      name: "Updated.md"
    });
    await act(async () =>
      Array.from(panelHost.querySelectorAll("button"))
        .find((button) => button.textContent === "Remove")!
        .click()
    );
    expect(deleteSource).toHaveBeenCalledWith({
      teamId: "team",
      projectId: "workspace",
      sourceId: "source",
      expectedProjectVersion: 2,
      expectedSourceVersion: 2
    });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(panelHost.textContent).toContain("Source removed");
    await act(async () =>
      Array.from(panelHost.querySelectorAll("button"))
        .find((button) => button.textContent === "Undo")!
        .click()
    );
    expect(patch.mock.calls[1]?.[3]).toMatchObject({
      deleted: false,
      expectedVersion: 3
    });
  });
  it("disables writing for a view-only member and closes its aside with Escape", async () => {
    const patch = vi.fn();
    const store = new SharedProjectStore({
      sharedRefresh: async () => state([source], true),
      sharedPatchSource: patch
    });
    await act(async () => store.setIdentity(identity));
    await act(async () =>
      root.render(
        <SharedProjectSources
          store={store}
          identity={identity}
          panelHost={panelHost}
        />
      )
    );
    await act(async () =>
      (
        container.querySelector(
          ".hq-project-sources__count"
        ) as HTMLButtonElement
      ).click()
    );
    expect(
      Array.from(panelHost.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Add a document")
      )!.disabled
    ).toBe(true);
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    );
    expect(panelHost.querySelector(".hq-project-sources__panel")).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });
  it("keeps the Source when reviewed Step-up is declined", async () => {
    const patch = vi.fn();
    const deleteSource = vi.fn(async () => {
      throw new Error("declined");
    });
    const store = new SharedProjectStore({
      sharedRefresh: async () => state([source]),
      sharedPatchSource: patch
    });
    await act(async () => store.setIdentity(identity));
    await act(async () =>
      root.render(
        <SharedProjectSources
          store={store}
          identity={identity}
          panelHost={panelHost}
          deleteSource={deleteSource}
        />
      )
    );
    await act(async () =>
      (
        container.querySelector(
          ".hq-project-sources__count"
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      (
        panelHost.querySelector(".hq-project-sources__row") as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      Array.from(panelHost.querySelectorAll("button"))
        .find((button) => button.textContent === "Remove")!
        .click()
    );
    expect(deleteSource).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
    expect(panelHost.textContent).toContain("Source removal was not completed");
    expect(panelHost.textContent).toContain("Plan.md");
  });
  it("adds a document through the trusted picker and shows only authorized content", async () => {
    let sources: WorkspaceProjectSource[] = [];
    const pick = vi.fn(async () => {
      sources = [source];
      return { canceled: false as const, source };
    });
    const read = vi.fn(async () => ({
      sourceId: source.sourceProjectSourceId,
      sourceRevisionId: "source-revision",
      noteRevisionId: "revision",
      noteId: "note",
      name: source.name,
      text: "Uploader's document"
    }));
    const store = new SharedProjectStore({
      sharedRefresh: async () => state(sources),
      sharedSourcePick: pick,
      sharedReadSource: read
    });
    await act(async () => store.setIdentity(identity));
    await act(async () =>
      root.render(
        <SharedProjectSources
          store={store}
          identity={identity}
          panelHost={panelHost}
        />
      )
    );
    await act(async () =>
      (
        container.querySelector(
          ".hq-project-sources__count"
        ) as HTMLButtonElement
      ).click()
    );
    await act(async () =>
      Array.from(panelHost.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Add a document"))!
        .click()
    );
    expect(pick).toHaveBeenCalledWith("workspace", "backend", "personal");
    expect(panelHost.textContent).toContain("Uploader's document");
    expect(read).toHaveBeenCalledWith(
      "workspace",
      "backend",
      "personal",
      "source"
    );
  });
});
