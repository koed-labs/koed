import { repositoryScopeId, type RepositoryIdentity } from "@koed/shared";
// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PersonalDesktopApi,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { PersonalMemoryStore } from "../../state/personal-memory.js";
import {
  ConversationProjectsDialog,
  NamedProjectActions
} from "./ProjectMembershipActions.js";
const uuid = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const stamp = "2026-10-19T12:00:00.000Z";
const repository: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_fixture",
  root: "/work/source",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout_fixture",
  originatingDeviceId: "fixture",
  selectedRemote: "origin",
  anchorDisplay: "example.test/source"
};
const sourceId = repositoryScopeId(repository);
const thread: PersonalDesktopProjectThread = {
  id: "provider-thread",
  name: "Cobalt decision",
  sessionId: uuid(1),
  sourceAiClient: "codex",
  projectId: sourceId,
  repositoryAssignment: {
    state: "recorded",
    version: 1,
    automatic: repository,
    override: null,
    effective: repository
  },
  projectName: "Source Git",
  projectPath: "/work/source",
  projectAssignmentSource: "detected",
  eventCount: 1,
  invalidatedCount: 0,
  latestAt: stamp,
  sample: "Decision",
  presentation: null
};
const named = (id: number, name: string): PersonalDesktopProject => ({
  id: uuid(id),
  name,
  path: null,
  eventCount: 0,
  threads: [],
  namedProject: {
    projectId: uuid(id),
    name,
    version: 1,
    headRevisionId: uuid(id + 1),
    deletedAt: null,
    createdAt: stamp,
    updatedAt: stamp
  }
});
const source: PersonalDesktopProject = {
  id: sourceId,
  name: "Source Git",
  path: "/work/source",
  eventCount: 1,
  threads: [thread]
};
const click = async (label: string) => {
  await act(async () => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (node) => node.textContent === label
    );
    expect(button, label).toBeTruthy();
    button!.click();
  });
};
const checkbox = (name: string) =>
  document.querySelector<HTMLInputElement>(
    `input[aria-label="Include in ${name}"]`
  )!;
const toggle = async (name: string) => act(async () => checkbox(name).click());
const reviewDetails = async (name: string) =>
  act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        `button[aria-label="Review membership in ${name}"]`
      )!
      .click()
  );
const type = async (
  node: HTMLInputElement | HTMLTextAreaElement,
  value: string
) => {
  await act(async () => {
    const prototype =
      node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("Personal Project inclusion controls", () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
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
  const fixture = async () => {
    let catalog = [source, named(10, "Release"), named(20, "Research")];
    const manage = vi.fn<NonNullable<PersonalDesktopApi["manageProject"]>>(
      async (input) => {
        const project = catalog.find((row) => row.id === input.projectId)!;
        if (project.namedProject!.version !== input.expectedVersion)
          throw new Error("Project changed");
        if (input.action === "explain_session")
          return {
            project: project.namedProject!,
            explanation: {
              sessionId: thread.sessionId!,
              logicalSessionId: uuid(2),
              reasons: project.threads[0]?.membershipReasons ?? [],
              exclusion: null,
              included: !!project.threads.length
            }
          };
        const updated = {
          ...project,
          namedProject: {
            ...project.namedProject!,
            version: project.namedProject!.version + 1
          }
        };
        const membership = {
          inclusionId: uuid(input.projectId === uuid(10) ? 12 : 22),
          projectId: project.id,
          logicalSessionId: uuid(2),
          sourceReference: null,
          version: 1,
          headRevisionId: uuid(30),
          removedAt: input.action === "remove_inclusion" ? stamp : null
        };
        if (input.action === "add_session")
          updated.threads = [
            {
              ...thread,
              id: uuid(2),
              sourceThreadId: thread.id,
              namedProjectId: project.id,
              sourceProject: {
                id: source.id,
                name: source.name,
                path: source.path
              },
              projectId: project.id,
              projectName: project.name,
              projectPath: null,
              membershipReasons: [
                {
                  inclusionId: membership.inclusionId,
                  revisionId: membership.headRevisionId,
                  kind: "session"
                }
              ]
            }
          ];
        if (input.action === "remove_inclusion") updated.threads = [];
        if (input.action === "rename") {
          updated.name = input.name;
          updated.namedProject.name = input.name;
        }
        if (input.action === "delete") updated.namedProject.deletedAt = stamp;
        catalog =
          input.action === "delete"
            ? catalog.filter((row) => row.id !== project.id)
            : catalog.map((row) => (row.id === project.id ? updated : row));
        return {
          project: updated.namedProject,
          membership:
            input.action === "add_session" ||
            input.action === "remove_inclusion"
              ? membership
              : undefined
        };
      }
    );
    const api: PersonalDesktopApi = {
      manageProject: manage,
      listProjects: async () => catalog,
      loadEventPage: async () => [],
      updateSessionTitle: async ({ title }) => ({ title }),
      updateSessionPresentation: async () => {
        throw new Error("unused");
      },
      subscribe: () => () => undefined
    };
    const store = new PersonalMemoryStore(api);
    await store.loadProjects();
    return { store, manage };
  };
  it("adds one Conversation to two Projects and removes one inclusion without a source move", async () => {
    const { store, manage } = await fixture();
    function View() {
      const snapshot = useSyncExternalStore(store.subscribe, store.current);
      return (
        <ConversationProjectsDialog
          thread={thread}
          projects={[...snapshot.projectsById.values()]}
          manage={manage}
          store={store}
        />
      );
    }
    await act(async () => root.render(<View />));
    await click("Add to Project");
    await toggle("Release");
    await toggle("Research");
    expect(
      manage.mock.calls.every(([input]) => input.action === "explain_session")
    ).toBe(true);
    await click("Confirm");
    expect(
      manage.mock.calls
        .filter(([input]) => input.action === "add_session")
        .map(([input]) => input)
    ).toEqual([
      {
        action: "add_session",
        projectId: uuid(10),
        expectedVersion: 1,
        sessionId: uuid(1)
      },
      {
        action: "add_session",
        projectId: uuid(20),
        expectedVersion: 1,
        sessionId: uuid(1)
      }
    ]);
    await click("Add to Project");
    expect(checkbox("Release").checked).toBe(true);
    expect(checkbox("Research").checked).toBe(true);
    await toggle("Release");
    await click("Confirm");
    expect(
      manage.mock.calls
        .filter(([input]) => input.action === "remove_inclusion")
        .at(-1)?.[0]
    ).toEqual({
      action: "remove_inclusion",
      projectId: uuid(10),
      expectedVersion: 2,
      inclusionId: uuid(12)
    });
    await click("Add to Project");
    expect(checkbox("Release").checked).toBe(false);
    expect(checkbox("Research").checked).toBe(true);
    expect(document.body.textContent).toContain("example.test/source");
    expect(thread.projectId).toBe(sourceId);
  });
  it("reviews every reason, preserves rules on direct removal, and pins exclusion and Add back to reviewed revisions", async () => {
    const project = named(10, "Release"),
      { store } = await fixture();
    let version = 4,
      excluded = false,
      direct = true,
      exclusionRevision = uuid(60);
    const reason = (kind: "session" | "repository" | "folder", id: number) => ({
      kind,
      inclusionId: uuid(id),
      revisionId: uuid(id + 1)
    });
    const manage = vi.fn<NonNullable<PersonalDesktopApi["manageProject"]>>(
      async (input) => {
        if (input.expectedVersion !== version)
          throw new Error("Project changed. Reload it before saving.");
        if (input.action === "remove_inclusion") {
          direct = false;
          version++;
        }
        if (input.action === "exclude_session") {
          excluded = true;
          version++;
        }
        if (input.action === "add_back") {
          expect(input.expectedExclusionRevisionId).toBe(exclusionRevision);
          excluded = false;
          direct = true;
          version++;
          exclusionRevision = uuid(61);
        }
        const reasons = [
          ...(direct ? [reason("session", 12)] : []),
          reason("repository", 32),
          reason("folder", 42)
        ];
        return {
          project: { ...project.namedProject!, version },
          explanation: {
            sessionId: thread.sessionId!,
            logicalSessionId: uuid(2),
            reasons,
            included: !excluded,
            exclusion:
              version >= 6
                ? {
                    exclusionId: uuid(50),
                    projectId: project.id,
                    logicalSessionId: uuid(2),
                    sourceReference: null,
                    version: excluded ? 1 : 2,
                    headRevisionId: exclusionRevision,
                    clearedAt: excluded ? null : stamp
                  }
                : null
          }
        };
      }
    );
    const render = async (catalogVersion: number) =>
      act(async () =>
        root.render(
          <ConversationProjectsDialog
            thread={thread}
            projects={[
              {
                ...project,
                namedProject: {
                  ...project.namedProject!,
                  version: catalogVersion
                }
              }
            ]}
            manage={manage}
            store={store}
          />
        )
      );
    await render(4);
    await click("Add to Project");
    await reviewDetails("Release");
    expect(document.body.textContent).toContain("Direct inclusion");
    expect(document.body.textContent).toContain("Git Anchor");
    expect(document.body.textContent).toContain("Folder");
    await click("Remove direct inclusion from Release");
    expect(direct).toBe(true);
    expect(checkbox("Release").checked).toBe(true);
    await click("Confirm");
    expect(direct).toBe(false);
    expect(excluded).toBe(false);
    await render(5);
    await click("Add to Project");
    await toggle("Release");
    expect(excluded).toBe(false);
    await click("Confirm");
    expect(manage).toHaveBeenLastCalledWith({
      action: "exclude_session",
      projectId: project.id,
      expectedVersion: 5,
      sessionId: thread.sessionId
    });
    await render(6);
    await click("Add to Project");
    expect(checkbox("Release").checked).toBe(false);
    await toggle("Release");
    expect(document.body.textContent).toContain("Adding back clears");
    await click("Add back to Release");
    expect(excluded).toBe(true);
    await render(100); // Catalog refresh cannot replace the reviewed exclusion revision.
    await click("Confirm");
    expect(manage).toHaveBeenLastCalledWith({
      action: "add_back",
      projectId: project.id,
      expectedVersion: 6,
      sessionId: thread.sessionId,
      exclusionId: uuid(50),
      expectedExclusionRevisionId: uuid(60)
    });
    expect(excluded).toBe(false);
    await render(7);
    await click("Add to Project");
    await toggle("Release");
    version = 8;
    const saved = manage.mock.calls.filter(
      ([input]) => input.action === "exclude_session"
    ).length;
    await click("Confirm");
    expect(document.body.textContent).toContain(
      "Project changed. Reload it before saving."
    );
    expect(
      manage.mock.calls.filter(([input]) => input.action === "exclude_session")
    ).toHaveLength(saved);
    expect(
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent === "Confirm"
      )!.disabled
    ).toBe(true);
  });
  it("discards checkbox edits without writing and opens a fresh draft", async () => {
    const { store, manage } = await fixture();
    await act(async () =>
      root.render(
        <ConversationProjectsDialog
          thread={thread}
          projects={[...store.current().projectsById.values()]}
          manage={manage}
          store={store}
        />
      )
    );
    await click("Add to Project");
    await toggle("Release");
    await click("Cancel");
    await click("Add to Project");
    expect(checkbox("Release").checked).toBe(false);
    expect(
      manage.mock.calls.every(([input]) => input.action === "explain_session")
    ).toBe(true);
  });
  it("stops a partial Confirm and disables replay", async () => {
    const { store, manage: backend } = await fixture();
    const manage = vi.fn<NonNullable<PersonalDesktopApi["manageProject"]>>(
      async (input) => {
        if (input.projectId === uuid(20) && input.action === "add_session")
          throw new Error("Simulated conflict");
        return backend(input);
      }
    );
    await act(async () =>
      root.render(
        <ConversationProjectsDialog
          thread={thread}
          projects={[...store.current().projectsById.values()]}
          manage={manage}
          store={store}
        />
      )
    );
    await click("Add to Project");
    await toggle("Release");
    await toggle("Research");
    await click("Confirm");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "1 change was saved before stopping"
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Simulated conflict"
    );
    const calls = manage.mock.calls.length;
    await click("Confirm");
    expect(manage).toHaveBeenCalledTimes(calls);
  });

  it("blocks an unresolved synchronized exclusion instead of bypassing it", async () => {
    const { store } = await fixture();
    const project = named(10, "Release");
    const manage = vi.fn<NonNullable<PersonalDesktopApi["manageProject"]>>(
      async () => ({
        project: project.namedProject!,
        explanation: {
          sessionId: thread.sessionId!,
          logicalSessionId: uuid(2),
          included: false,
          reasons: [],
          exclusion: null,
          syncExclusion: {
            entityId: "exclusion",
            state: "conflict",
            heads: ["a", "b"],
            blocked: true
          }
        }
      })
    );
    await act(async () =>
      root.render(
        <ConversationProjectsDialog
          thread={thread}
          projects={[project]}
          manage={manage}
          store={store}
        />
      )
    );
    await click("Add to Project");
    expect(checkbox("Release").disabled).toBe(true);
    await reviewDetails("Release");
    expect(document.body.textContent).toContain(
      "Open this Project’s Sync details"
    );
    await click("Confirm");
    expect(manage).toHaveBeenCalledTimes(1);
  });
  it("rejects a membership review for another Conversation without writing", async () => {
    const { store } = await fixture();
    const project = named(10, "Release");
    const manage = vi.fn<NonNullable<PersonalDesktopApi["manageProject"]>>(
      async () => ({
        project: project.namedProject!,
        explanation: {
          sessionId: uuid(999),
          logicalSessionId: uuid(2),
          included: false,
          reasons: [],
          exclusion: null
        }
      })
    );
    await act(async () =>
      root.render(
        <ConversationProjectsDialog
          thread={thread}
          projects={[project]}
          manage={manage}
          store={store}
        />
      )
    );
    await click("Add to Project");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be verified"
    );
    await click("Confirm");
    expect(manage).toHaveBeenCalledTimes(1);
  });
  it("retains an open rename draft and rejects its old version after a background refresh", async () => {
    const { store, manage } = await fixture();
    function View() {
      const snapshot = useSyncExternalStore(store.subscribe, store.current);
      return (
        <NamedProjectActions
          project={snapshot.projectsById.get(uuid(10))!}
          manage={manage}
          store={store}
          onDeleted={() => undefined}
        />
      );
    }
    await act(async () => root.render(<View />));
    await click("Edit Project");
    await type(document.querySelector("input")!, "My draft name");
    await act(async () => {
      await manage({
        action: "rename",
        projectId: uuid(10),
        expectedVersion: 1,
        name: "Other device name"
      });
      await store.loadProjects();
    });
    expect(document.querySelector("input")!.value).toBe("My draft name");
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
    expect(manage).toHaveBeenLastCalledWith({
      action: "rename",
      projectId: uuid(10),
      expectedVersion: 1,
      name: "My draft name"
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Project changed"
    );
    expect(store.current().projectsById.get(uuid(10))?.name).toBe(
      "Other device name"
    );
  });

  it("renames and removes a named Project with its current version", async () => {
    const { store, manage } = await fixture(),
      deleted = vi.fn();
    function View() {
      const snapshot = useSyncExternalStore(store.subscribe, store.current);
      const project = snapshot.projectsById.get(uuid(10));
      return project ? (
        <NamedProjectActions
          project={project}
          manage={manage}
          store={store}
          onDeleted={deleted}
        />
      ) : null;
    }
    await act(async () => root.render(<View />));
    await click("Edit Project");
    await type(document.querySelector("input")!, "Release plan");
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
    expect(manage).toHaveBeenLastCalledWith({
      action: "rename",
      projectId: uuid(10),
      expectedVersion: 1,
      name: "Release plan"
    });
    await click("Edit Project");
    await click("Remove Project");
    expect(manage).toHaveBeenLastCalledWith({
      action: "delete",
      projectId: uuid(10),
      expectedVersion: 2
    });
    expect(deleted).toHaveBeenCalledOnce();
    expect(store.current().projectsById.get(source.id)?.threads).toEqual([
      thread
    ]);
  });
});
