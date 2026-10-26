// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  personalFolderScopeId,
  repositoryScopeId,
  type PersonalGitContext,
  type PersonalProjectRule
} from "@koed/shared";
import type {
  PersonalDesktopApi,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { mergeProjectSources } from "../../../project-memory-ui.js";
import { PersonalMemoryStore } from "../../state/personal-memory.js";
import { ProjectOrganization } from "./ProjectOrganization.js";
import { projectTransferSources } from "./project-transfer-model.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-10-20T09:00:00.000Z";
const repository: PersonalGitContext = {
  kind: "portable_repository",
  key: "gr_koed",
  root: "/work/koed",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout",
  originatingDeviceId: "device",
  selectedRemote: "origin",
  anchorDisplay: "example.test/koed"
};
const folder = {
  reference: {
    ownerUserId: uuid(99),
    folderId: "api",
    originatingDeploymentId: "deployment",
    originatingDeviceId: "device",
    originatingProfileId: "profile",
    directoryIncarnationId: "api-lifetime"
  },
  normalizedPath: "/work/koed/api",
  capturedPath: "/work/koed/api"
};
const threads: PersonalDesktopProjectThread[] = [1, 2].map((n) => ({
  id: `external-${n}`,
  name: `Conversation ${n}`,
  sessionId: uuid(n),
  sourceReferences: [
    {
      sessionId: uuid(n),
      logicalSessionId: uuid(n + 10),
      logicalMemoryId: null
    }
  ],
  sourceAiClient: "codex",
  projectId: repositoryScopeId(repository),
  projectName: "koed",
  projectPath: repository.root,
  capturedCwd: folder.normalizedPath,
  projectAssignmentSource: "detected",
  eventCount: 1,
  invalidatedCount: 0,
  latestAt: stamp,
  sample: "",
  presentation: null
}));
function fixture({
  wrongPreview = false,
  blocked = false,
  failSecond = false,
  included = false,
  historical = false
} = {}) {
  const named: PersonalDesktopProject = {
    id: uuid(90),
    name: "Release",
    path: null,
    eventCount: 0,
    threads: [],
    directInclusions: [],
    inclusionRules: [],
    namedProject: {
      projectId: uuid(90),
      name: "Release",
      version: 1,
      headRevisionId: uuid(91),
      deletedAt: null,
      createdAt: stamp,
      updatedAt: stamp
    }
  };
  let catalog: PersonalDesktopProject[] = [
    {
      id: repositoryScopeId(repository),
      name: "koed",
      repository,
      path: repository.root,
      eventCount: 2,
      threads
    },
    {
      id: personalFolderScopeId(folder.reference),
      name: "API",
      folder,
      path: folder.normalizedPath,
      eventCount: 2,
      threads: threads.map((t) => ({
        ...t,
        folderSelection: folder.reference,
        projectId: personalFolderScopeId(folder.reference)
      }))
    },
    {
      id: repositoryScopeId({ ...repository, key: "gr_website" }),
      name: "Website",
      repository: { ...repository, key: "gr_website" },
      path: "/work/website",
      eventCount: 0,
      threads: []
    },
    named
  ];
  if (historical) {
    const root = "/work/recall-environment";
    catalog = [
      {
        id: "historical-recall",
        name: "recall-environment",
        path: root,
        repository: {
          ...repository,
          kind: "non_git_project",
          key: "ng_recall",
          root,
          reason: "non_git",
          checkoutId: null,
          selectedRemote: null,
          anchorDisplay: null
        },
        eventCount: 2,
        threads: threads.map((thread) => ({ ...thread, projectPath: root }))
      },
      named
    ];
  }
  let sequence = 100,
    writes = 0;
  const manage = vi.fn<NonNullable<PersonalDesktopApi["manageProject"]>>(
    async (input) => {
      const project = catalog.at(-1)!;
      if (
        input.projectId !== project.id ||
        input.expectedVersion !== project.namedProject!.version
      )
        throw new Error("Project changed. Reload it and try again.");
      if (
        input.action === "preview_repository" ||
        input.action === "preview_folder"
      )
        return {
          project: project.namedProject!,
          preview: {
            target: wrongPreview
              ? {
                  kind: "repository",
                  repository: { ...repository, key: "gr_wrong" }
                }
              : input.action === "preview_repository"
                ? { kind: "repository", repository: input.repository }
                : { kind: "folder", folder: input.folder },
            conversations: threads.map((t) => ({
              sessionId: t.sessionId!,
              logicalSessionId: t.sourceReferences![0]!.logicalSessionId,
              name: t.name
            }))
          }
        };
      if (input.action === "explain_session")
        return {
          project: project.namedProject!,
          explanation: {
            sessionId: input.sessionId,
            logicalSessionId: uuid(11),
            included: project.threads.some(
              (thread) => thread.sessionId === input.sessionId
            ),
            reasons: [],
            exclusion: blocked
              ? {
                  exclusionId: uuid(800),
                  projectId: project.id,
                  logicalSessionId: uuid(11),
                  sourceReference: null,
                  version: 1,
                  headRevisionId: uuid(801),
                  clearedAt: null
                }
              : null
          }
        };
      writes++;
      if (failSecond && writes === 2) throw new Error("Simulated conflict");
      const updated = {
        ...project,
        namedProject: {
          ...project.namedProject!,
          version: project.namedProject!.version + 1
        },
        inclusionRules: [...project.inclusionRules!],
        directInclusions: [...project.directInclusions!]
      };
      let rule: PersonalProjectRule | undefined;
      if (input.action === "add_repository" || input.action === "add_folder") {
        rule = {
          inclusionId: uuid(sequence++),
          projectId: project.id,
          target:
            input.action === "add_repository"
              ? { kind: "repository", repository: input.repository }
              : { kind: "folder", folder: input.folder },
          version: 1,
          headRevisionId: uuid(sequence++),
          removedAt: null
        };
        updated.inclusionRules.push(rule);
      } else if (input.action === "add_session") {
        updated.directInclusions.push({
          inclusionId: uuid(sequence++),
          projectId: project.id,
          logicalSessionId: threads.find(
            (t) => t.sessionId === input.sessionId
          )!.sourceReferences![0]!.logicalSessionId,
          sourceReference: null,
          version: 1,
          headRevisionId: uuid(sequence++),
          removedAt: null
        });
      } else if (input.action === "remove_rule")
        updated.inclusionRules = updated.inclusionRules.filter(
          (r) => r.inclusionId !== input.inclusionId
        );
      else if (input.action === "remove_inclusion")
        updated.directInclusions = updated.directInclusions.filter(
          (r) => r.inclusionId !== input.inclusionId
        );
      else if (input.action === "exclude_session")
        updated.threads = updated.threads.filter(
          (thread) => thread.sessionId !== input.sessionId
        );
      else throw new Error("Unexpected fixture command");
      catalog = [...catalog.slice(0, -1), updated];
      return {
        project: updated.namedProject,
        rule,
        membership:
          input.action === "add_session"
            ? updated.directInclusions.at(-1)
            : undefined
      };
    }
  );
  if (included) {
    named.threads = blocked ? [threads[1]!] : [...threads];
    named.inclusionRules = [
      {
        inclusionId: uuid(700),
        projectId: named.id,
        target: { kind: "repository", repository },
        version: 1,
        headRevisionId: uuid(701),
        removedAt: null
      }
    ];
    named.directInclusions = [
      {
        inclusionId: uuid(702),
        projectId: named.id,
        logicalSessionId: uuid(11),
        sourceReference: null,
        version: 1,
        headRevisionId: uuid(703),
        removedAt: null
      }
    ];
  }
  const store = new PersonalMemoryStore({
    listProjects: async () => catalog,
    loadEventPage: async () => [],
    subscribe: () => () => undefined,
    assignSessionProject: async () => ({ projectId: null }),
    updateSessionTitle: async ({ title }) => ({ title }),
    updateSessionPresentation: async () => {
      throw new Error("Not used");
    }
  });
  const sync = vi.fn<NonNullable<PersonalDesktopApi["manageMembershipSync"]>>(
    async () => {
      throw new Error("Sync fixture unavailable");
    }
  );
  function Host() {
    const state = useSyncExternalStore(store.subscribe, store.current);
    const projects = [...state.projectsById.values()];
    const project = projects.find((p) => p.id === named.id);
    return project ? (
      <ProjectOrganization
        project={project}
        projects={projects}
        manage={manage}
        sync={sync}
        store={store}
        onDeleted={() => undefined}
      />
    ) : null;
  }
  return {
    Host,
    manage,
    sync,
    store,
    project: () => catalog.at(-1)!,
    remoteChange: () => {
      const current = catalog.at(-1)!;
      catalog = [
        ...catalog.slice(0, -1),
        {
          ...current,
          namedProject: {
            ...current.namedProject!,
            version: current.namedProject!.version + 1
          }
        }
      ];
    }
  };
}
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label
  )!;
const click = async (label: string) =>
  act(async () => {
    expect(button(label), label).toBeTruthy();
    button(label).click();
  });
const select = async (label: string) =>
  act(async () => {
    const input = [
      ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    ].find((i) => i.closest("label")!.textContent === label);
    expect(input, label).toBeTruthy();
    input!.click();
  });
describe("Project header and transfer card", () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const mount = async (options: Parameters<typeof fixture>[0] = {}) => {
    const f = fixture(options);
    await act(async () => {
      await f.store.loadProjects();
      root.render(<f.Host />);
    });
    await click("Set up Project");
    return f;
  };
  it("lists historical folders and stages their existing Conversations without a future rule", async () => {
    const f = await mount({ historical: true });
    await click("Folders");
    const available = document.querySelector(
      '[aria-label="Available sources list"]'
    )!;
    expect(available.textContent).toContain("recall-environment");
    expect(available.textContent).toContain("Existing Conversations only");
    await click("Browse Conversations in recall-environment");
    expect(available.textContent).toContain("Conversation 1");
    expect(available.textContent).toContain("Conversation 2");
    await click("Folders");
    await select("Select recall-environment");
    await click("Include selected in Project");
    expect(f.manage).not.toHaveBeenCalled();
    expect(
      document.querySelector('[aria-label="Project inclusions list"]')
        ?.textContent
    ).toContain("Conversation 1");
    await click("Confirm");
    expect(f.manage.mock.calls.map(([command]) => command.action)).toEqual([
      "explain_session",
      "add_session",
      "explain_session",
      "add_session"
    ]);
    expect(f.project().directInclusions).toHaveLength(2);
    expect(f.project().inclusionRules).toHaveLength(0);
  });
  it("keeps exclusions when including a historical folder's Conversations", async () => {
    const f = await mount({ historical: true, blocked: true });
    await click("Folders");
    await select("Select recall-environment");
    await click("Include selected in Project");
    await click("Confirm");
    expect(f.manage.mock.calls.map(([command]) => command.action)).toEqual([
      "explain_session"
    ]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "excluded"
    );
    expect(f.project().directInclusions).toHaveLength(0);
  });
  it("keeps setup out of document flow and opens Edit and Sync from Project actions", async () => {
    const f = fixture();
    await act(async () => {
      await f.store.loadProjects();
      root.render(<f.Host />);
    });
    expect(document.querySelector(".personal-project-transfer")).toBeNull();
    expect(button("Set up Project").textContent).toBe("");
    expect(button("Set up Project").className).toBe(
      button("Project actions").className
    );
    await click("Project actions");
    await act(async () => {
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((node) => node.textContent === "Edit")!
        .click();
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Edit Project"
    );
    expect(button("Remove Project").className).toContain("bg-destructive");
    await click("Close");
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(button("Project actions"))
    );
    await click("Project actions");
    await act(async () => {
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((node) => node.textContent === "Sync")!
        .click();
    });
    expect(f.sync).toHaveBeenCalledWith({
      action: "list",
      projectId: f.project().id,
      afterEntityId: undefined
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Project sync details"
    );
  });
  it("keeps source drill-down separate from selection and transfers an exact Folder", async () => {
    const f = await mount();
    expect(button("Project actions")).toBeTruthy();
    expect(button("Close Project setup").textContent).toBe("");
    expect(container.textContent).not.toContain("Git Anchor inclusions");
    await click("Browse Folders in koed");
    expect(f.manage).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe(
      "koed"
    );
    await select("Select API");
    await click("Include selected in Project");
    expect(f.manage).not.toHaveBeenCalled();
    expect(f.project().inclusionRules).toHaveLength(0);
    await click("Browse Conversations in API");
    expect(
      document.querySelector('[aria-label="Available sources list"]')
        ?.textContent
    ).toContain("Conversation 1");
    expect(
      document.querySelectorAll('[aria-current="page"]')[0]?.textContent
    ).toBe("API");
    await select("Select Conversation 1");
    await click("Include selected in Project");
    expect(f.manage).not.toHaveBeenCalled();
    await click("Confirm");
    expect(f.project().inclusionRules).toHaveLength(1);
    expect(f.project().directInclusions).toHaveLength(1);
    expect(f.manage.mock.calls[1]![0]).toMatchObject({
      folder: folder.reference,
      expectedVersion: 1
    });
    expect(f.manage.mock.calls.at(-1)![0]).toMatchObject({
      action: "add_session",
      sessionId: uuid(1),
      expectedVersion: 2
    });
    expect(container.textContent).not.toContain("Already included");
  });
  it("removes one overlapping reason only on Confirm", async () => {
    const f = await mount({ included: true });
    await select("Remove inclusion for koed");
    await click("Remove selected inclusions");
    expect(f.project().inclusionRules).toHaveLength(1);
    expect(f.manage).not.toHaveBeenCalled();
    await click("Confirm");
    expect(f.project().inclusionRules).toHaveLength(0);
    expect(f.project().directInclusions).toHaveLength(1);
    expect(f.manage.mock.calls.map(([c]) => c.action)).toEqual(["remove_rule"]);
  });
  it("discards staged edits on Cancel and reopens a fresh draft", async () => {
    const f = await mount();
    await select("Select koed");
    await click("Include selected in Project");
    await click("Cancel");
    await vi.waitFor(() =>
      expect(document.querySelector(".personal-project-transfer")).toBeNull()
    );
    await click("Set up Project");
    expect(
      document.querySelector('[aria-label="Project inclusions list"]')
        ?.textContent
    ).not.toContain("koed");
    expect(f.manage).not.toHaveBeenCalled();
    expect(f.project().inclusionRules).toHaveLength(0);
  });
  it("drills through included Git and Folder identities and excludes just a Conversation", async () => {
    const f = await mount({ included: true });
    const available = document.querySelector<HTMLDivElement>(
      '[aria-label="Available sources list"]'
    )!;
    const includedList = document.querySelector<HTMLDivElement>(
      '[aria-label="Project inclusions list"]'
    )!;
    available.scrollTop = 80;
    includedList.scrollTop = 90;
    await click("Browse included Folders in koed");
    expect(available.scrollTop).toBe(80);
    expect(includedList.scrollTop).toBe(0);
    await click("Browse included Conversations in API");
    await select("Exclude from Project: Conversation 1");
    await click("Remove selected inclusions");
    expect(includedList.textContent).not.toContain("Conversation 1");
    expect(includedList.textContent).toContain("Conversation 2");
    expect(f.manage).not.toHaveBeenCalled();
    await click("Confirm");
    expect(f.manage.mock.calls.map(([c]) => c.action)).toEqual([
      "explain_session",
      "exclude_session"
    ]);
    expect(f.manage.mock.calls[1]![0]).toMatchObject({
      sessionId: uuid(1),
      expectedVersion: 1
    });
    expect(f.project().inclusionRules).toHaveLength(1);
    expect(f.project().directInclusions).toHaveLength(1);
    expect(f.project().threads.map((thread) => thread.sessionId)).toEqual([
      uuid(2)
    ]);
  });
  it("omits excluded Conversations from rule drill-down", async () => {
    await mount({ included: true, blocked: true });
    await click("Browse included Folders in koed");
    await click("Browse included Conversations in API");
    const list = document.querySelector(
      '[aria-label="Project inclusions list"]'
    )!;
    expect(list.textContent).not.toContain("Conversation 1");
    expect(list.textContent).toContain("Conversation 2");
  });
  it("browses included Folders directly from the right selector", async () => {
    const f = await mount({ included: true });
    await act(async () => {
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[aria-label="Project inclusion path"] button'
        )
      ]
        .find((node) => node.textContent === "Folders")!
        .click();
    });
    expect(
      document.querySelector('[aria-label="Project inclusions list"]')
        ?.textContent
    ).toContain("API");
    await click("Browse included Conversations in API");
    expect(
      document.querySelector('[aria-label="Project inclusions list"]')
        ?.textContent
    ).toContain("Conversation 1");
    expect(f.manage).not.toHaveBeenCalled();
  });
  it("stops a partial batch at a conflict and never replays saved writes", async () => {
    const f = await mount({ failSecond: true });
    await select("Select koed");
    await select("Select Website");
    await click("Include selected in Project");
    await click("Confirm");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Simulated conflict"
    );
    expect(f.project().inclusionRules).toHaveLength(1);
    expect(
      f.manage.mock.calls
        .filter(([command]) => command.action === "add_repository")
        .map(([command]) => command.expectedVersion)
    ).toEqual([1, 2]);
    expect(button("Confirm").disabled).toBe(true);
    const calls = f.manage.mock.calls.length;
    await click("Confirm");
    expect(f.manage).toHaveBeenCalledTimes(calls);
  });
  it("rejects Confirm after an unobserved remote edit rather than rebasing the draft", async () => {
    const f = await mount();
    await select("Select koed");
    await click("Include selected in Project");
    f.remoteChange();
    await click("Confirm");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Project changed"
    );
    expect(f.project().inclusionRules).toHaveLength(0);
    expect(f.manage.mock.calls.at(-1)![0]).toMatchObject({
      action: "preview_repository",
      expectedVersion: 1
    });
  });
  it("rejects a preview for another target without sending a write", async () => {
    const f = await mount({ wrongPreview: true });
    await select("Select koed");
    await click("Include selected in Project");
    await click("Confirm");
    expect(f.manage.mock.calls.map(([c]) => c.action)).toEqual([
      "preview_repository"
    ]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "source changed"
    );
  });
  it("does not silently clear an exclusion when a Conversation is selected", async () => {
    const f = await mount({ blocked: true });
    await click("Browse Folders in koed");
    await click("Browse Conversations in API");
    await select("Select Conversation 1");
    await click("Include selected in Project");
    await click("Confirm");
    expect(f.manage.mock.calls.map(([c]) => c.action)).toEqual([
      "explain_session"
    ]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "excluded"
    );
  });
  it("retains scroll positions when selecting and resets only the source list on navigation", async () => {
    await mount();
    const available = document.querySelector<HTMLDivElement>(
      '[aria-label="Available sources list"]'
    )!;
    const included = document.querySelector<HTMLDivElement>(
      '[aria-label="Project inclusions list"]'
    )!;
    available.scrollTop = 80;
    included.scrollTop = 35;
    await select("Select koed");
    expect(available.scrollTop).toBe(80);
    expect(included.scrollTop).toBe(35);
    await click("Browse Folders in koed");
    expect(available.scrollTop).toBe(0);
    expect(included.scrollTop).toBe(35);
  });
});

describe("recorded source hierarchy", () => {
  const historical = (
    device: string,
    conversations: PersonalDesktopProjectThread[]
  ): PersonalDesktopProject => ({
    id: `historical-${device}`,
    name: "recall-environment",
    path: "/work/recall-environment",
    repository: {
      ...repository,
      kind: "non_git_project",
      key: "ng_recall",
      originatingDeviceId: device,
      root: "/work/recall-environment",
      reason: "non_git",
      checkoutId: null,
      selectedRemote: null,
      anchorDisplay: null
    },
    eventCount: conversations.length,
    threads: conversations
  });

  it("keeps equal historical paths on different devices separate without creating Folder targets", () => {
    const catalog = projectTransferSources(
      mergeProjectSources(
        [historical("one", [threads[0]!]), historical("two", [threads[1]!])],
        []
      )
    );

    expect(catalog.folders).toHaveLength(2);
    expect(catalog.folders.map((row) => row.target)).toEqual([
      undefined,
      undefined
    ]);
    expect(
      catalog.folders.map((row) =>
        catalog.children(row).map((child) => child.sessionId)
      )
    ).toEqual([[threads[0]!.sessionId], [threads[1]!.sessionId]]);
  });

  it("uses established Folder membership before historical display groups", () => {
    const catalog = projectTransferSources(
      mergeProjectSources(
        [
          historical("device", threads),
          {
            id: personalFolderScopeId(folder.reference),
            name: "API",
            folder,
            path: folder.normalizedPath,
            eventCount: 1,
            threads: [threads[0]!]
          }
        ],
        []
      )
    );
    const recorded = catalog.folders.find((row) => row.target);
    const older = catalog.folders.find((row) => !row.target);

    expect(catalog.folders).toHaveLength(2);
    expect(recorded?.threads.map((thread) => thread.sessionId)).toEqual([
      threads[0]!.sessionId
    ]);
    expect(older?.threads.map((thread) => thread.sessionId)).toEqual([
      threads[1]!.sessionId
    ]);
  });

  it("uses source bindings rather than equal paths or external thread labels for Git/Folder intersection", () => {
    const f = fixture();
    const snapshots = f.project();
    expect(snapshots.namedProject).toBeTruthy();
    const git = {
      id: "git",
      name: "koed",
      repository,
      path: repository.root,
      eventCount: 2,
      threads
    };
    const foreign = {
      ...folder,
      reference: {
        ...folder.reference,
        folderId: "foreign",
        originatingDeviceId: "another-device"
      }
    };
    const catalog = projectTransferSources(
      mergeProjectSources(
        [
          git,
          {
            id: "api",
            name: "API",
            folder,
            path: folder.normalizedPath,
            eventCount: 2,
            threads
          },
          {
            id: "foreign",
            name: "API",
            folder: foreign,
            path: folder.normalizedPath,
            eventCount: 1,
            threads: [
              {
                ...threads[0]!,
                sessionId: uuid(500),
                sourceReferences: [
                  {
                    sessionId: uuid(500),
                    logicalSessionId: uuid(501),
                    logicalMemoryId: null
                  }
                ]
              }
            ]
          }
        ],
        []
      )
    );
    expect(catalog.folders).toHaveLength(2);
    expect(
      catalog.children(catalog.repositories[0]!).map((row) => row.id)
    ).toEqual([personalFolderScopeId(folder.reference)]);
  });
});
