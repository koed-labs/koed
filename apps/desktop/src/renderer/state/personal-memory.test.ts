import { createProjectSourceFixture } from "../../project-source-fixture.js";
import { repositoryScopeId, type RepositoryIdentity } from "@koed/shared";
import type {
  PersonalDesktopApi,
  PersonalDesktopChange,
  PersonalDesktopConversationEvent,
  PersonalDesktopProject,
  PersonalDesktopProjectMetadata,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { PERSONAL_DESKTOP_CONTRACT_VERSION } from "@koed/shared/personal-desktop";
import { describe, expect, it, vi } from "vitest";
import {
  PersonalMemoryStore,
  personalMemoryCacheLimit,
  personalMemoryPrewarmConcurrency,
  personalMemoryPrewarmLimit,
  personalMemoryThreadKey
} from "./personal-memory.js";

const thread = (
  index: number,
  projectId = "project"
): PersonalDesktopProjectThread => ({
  id: `thread-${index}`,
  name: `Thread ${index}`,
  sessionId: null,
  sourceAiClient: "codex",
  projectId,
  projectName: "Project",
  projectPath: "/tmp/project",
  projectAssignmentSource: "detected",
  eventCount: 100,
  invalidatedCount: 0,
  latestAt: "2026-07-23T00:00:00.000Z",
  sample: `Sample ${index}`,
  presentation: null
});

const event = (index: number): PersonalDesktopConversationEvent => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  actor: index % 2 ? "assistant" : "user",
  eventType: "message",
  timestamp: new Date(Date.UTC(2026, 6, 23, 0, 0, index)).toISOString(),
  sourceEventTime: null,
  sourceSequence: index,
  content: `Event ${index}`,
  contentPreview: `Event ${index}`,
  invalidatedAt: null,
  metadata: {}
});

const project = (
  threads: PersonalDesktopProjectThread[]
): PersonalDesktopProject => ({
  id: "project",
  name: "Project",
  path: "/tmp/project",
  eventCount: threads.reduce((total, item) => total + item.eventCount, 0),
  threads
});

const api = (overrides: Partial<PersonalDesktopApi> = {}) =>
  ({
    listProjects: vi.fn(async () => []),
    loadEventPage: vi.fn(async () => []),
    updateSessionTitle: vi.fn(async ({ title }) => ({ title })),
    updateSessionPresentation: vi.fn(async () => {
      throw new Error("not used");
    }),
    subscribe: vi.fn(() => () => undefined),
    ...overrides
  }) satisfies PersonalDesktopApi;

describe("PersonalMemoryStore", () => {
  it("publishes an empty named Project before first-launch preparation and enriches its native Folder afterwards", async () => {
    const fixture = createProjectSourceFixture();
    const empty = { ...fixture.project, threads: [], eventCount: 0 };
    let folders: typeof fixture.localFolders = [];
    let finish!: (folder: (typeof fixture.localFolders)[number]) => void;
    const pending = new Promise<(typeof fixture.localFolders)[number]>(
      (resolve) => {
        finish = resolve;
      }
    );
    const prepareLocalFolder = vi.fn(async () => {
      const folder = await pending;
      folders = [folder];
      return folder;
    });
    const store = new PersonalMemoryStore(
      api({
        listProjects: async () => [empty],
        listProjectMetadata: async () => fixture.metadata,
        listLocalFolders: async () => folders,
        prepareLocalFolder
      })
    );
    const loading = store.loadProjects();
    await vi.waitFor(() =>
      expect(prepareLocalFolder).toHaveBeenCalledWith({
        localProjectId: "lp_fixture_local"
      })
    );
    expect(store.current().inventory.projects[0]?.id).toBe(empty.id);
    expect(store.current().loading).toBe(false);
    expect(store.current().inventory.localFolders).toEqual([]);
    finish(fixture.localFolders[0]!);
    await loading;
    expect(store.current().inventory.localFolders).toEqual([
      fixture.localFolders[0]
    ]);
    expect(store.current().error).toBeNull();
  });

  it("retains the Project catalog when native first-launch preparation is rejected", async () => {
    const fixture = createProjectSourceFixture();
    const store = new PersonalMemoryStore(
      api({
        listProjects: async () => fixture.groups,
        listProjectMetadata: async () => fixture.metadata,
        listLocalFolders: async () => [],
        prepareLocalFolder: vi.fn(async () => {
          throw new Error("Folder replaced");
        })
      })
    );
    await store.loadProjects();
    expect(
      store.current().inventory.projects.map((project) => project.id)
    ).toContain(fixture.projectId);
    expect(store.current().inventory.localFolders).toEqual([]);
    expect(store.current().error).toBeNull();
  });

  it("publishes named Projects while source enumeration and native enrichment remain pending", async () => {
    const fixture = createProjectSourceFixture();
    let finishInventory!: (projects: PersonalDesktopProject[]) => void;
    let finishMetadata!: (metadata: PersonalDesktopProjectMetadata[]) => void;
    let finishStatus!: (status: { reconciliationPending: boolean }) => void;
    const full = new Promise<PersonalDesktopProject[]>((resolve) => {
      finishInventory = resolve;
    });
    const metadata = new Promise<PersonalDesktopProjectMetadata[]>(
      (resolve) => {
        finishMetadata = resolve;
      }
    );
    const status = new Promise<{ reconciliationPending: boolean }>(
      (resolve) => {
        finishStatus = resolve;
      }
    );
    const initial = fixture.groups.filter((group) => group.namedProject);
    const initialRead = vi.fn(async () => initial);
    const metadataRead = vi.fn(() => metadata);
    const store = new PersonalMemoryStore(
      api({
        listProjects: () => full,
        listNamedProjects: initialRead,
        listProjectMetadata: metadataRead,
        listLocalFolders: async () => fixture.localFolders,
        projectStatus: () => status
      })
    );
    const read = store.loadProjects();
    await vi.waitFor(() =>
      expect(store.current().inventory.projects.map((p) => p.id)).toEqual([
        fixture.projectId
      ])
    );
    expect(store.current().loading).toBe(true);
    expect(store.current().inventory.gitSources).toHaveLength(0);
    expect(metadataRead).toHaveBeenCalledOnce();
    finishMetadata(fixture.metadata);
    finishStatus({ reconciliationPending: false });
    await vi.waitFor(() =>
      expect(store.current().inventory.localFolders).toEqual(
        fixture.localFolders
      )
    );
    expect(store.current().inventory.projects).toHaveLength(1);
    finishInventory(fixture.groups);
    const complete = await read;
    expect(complete.loading).toBe(false);
    expect(complete.inventory.gitSources).toHaveLength(2);
    expect(complete.inventory.folders).toHaveLength(3);
    expect(complete.inventory.projects[0]?.threads).toHaveLength(4);
    await store.loadProjects();
    expect(initialRead).toHaveBeenCalledOnce();
  });

  it("does not let a late initial Project response overwrite a complete inventory", async () => {
    const fixture = createProjectSourceFixture();
    let finishInitial!: (projects: PersonalDesktopProject[]) => void;
    const initial = new Promise<PersonalDesktopProject[]>((resolve) => {
      finishInitial = resolve;
    });
    const store = new PersonalMemoryStore(
      api({
        listProjects: async () => fixture.groups,
        listNamedProjects: () => initial
      })
    );
    await store.loadProjects();
    const complete = store.current();
    finishInitial([]);
    await initial;
    await Promise.resolve();
    expect(store.current()).toBe(complete);
    expect(complete.inventory.gitSources).toHaveLength(2);
  });

  it("retains the named inventory when source browsing fails, and falls back to the complete read if the initial read fails", async () => {
    const fixture = createProjectSourceFixture();
    const initial = fixture.groups.filter((group) => group.namedProject);
    const store = new PersonalMemoryStore(
      api({
        listProjects: async () => {
          throw new Error("Source enumeration failed");
        },
        listNamedProjects: async () => initial
      })
    );
    const failed = await store.loadProjects();
    expect(failed.inventory.projects[0]?.id).toBe(fixture.projectId);
    expect(failed.loading).toBe(false);
    expect(failed.error).toBe("Source enumeration failed");
    const fallback = new PersonalMemoryStore(
      api({
        listProjects: async () => fixture.groups,
        listNamedProjects: async () => {
          throw new Error("Initial read failed");
        }
      })
    );
    expect((await fallback.loadProjects()).inventory.projects[0]?.id).toBe(
      fixture.projectId
    );
    expect(fallback.current().error).toBeNull();
  });

  it("ignores startup responses superseded by a newer inventory load", async () => {
    const fixture = createProjectSourceFixture();
    let finishOld!: (projects: PersonalDesktopProject[]) => void;
    let finishOldInitial!: (projects: PersonalDesktopProject[]) => void;
    const old = new Promise<PersonalDesktopProject[]>((resolve) => {
      finishOld = resolve;
    });
    const oldInitial = new Promise<PersonalDesktopProject[]>((resolve) => {
      finishOldInitial = resolve;
    });
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi
          .fn()
          .mockReturnValueOnce(old)
          .mockResolvedValueOnce(fixture.groups),
        listNamedProjects: vi
          .fn()
          .mockReturnValueOnce(oldInitial)
          .mockResolvedValueOnce(
            fixture.groups.filter((group) => group.namedProject)
          )
      })
    );
    const pending = store.loadProjects();
    await store.loadProjects();
    const current = store.current();
    finishOldInitial([]);
    finishOld([]);
    await pending;
    expect(store.current()).toBe(current);
  });

  it("merges local Project metadata into the rendered Project index", async () => {
    // Only a shared repository identity links local metadata to a graph Project.
    const repository: RepositoryIdentity = {
      kind: "portable_repository",
      key: "gr_koed",
      root: "/tmp/project",
      branch: "main",
      reason: "origin",
      checkoutId: "checkout_koed",
      originatingDeviceId: "fixture_device",
      selectedRemote: "origin",
      anchorDisplay: "github.com/koed-labs/koed"
    };
    const source = { ...project([thread(1)]), repository };
    const metadata: PersonalDesktopProjectMetadata = {
      schemaVersion: 1,
      discoveredAt: "2026-07-22T00:00:00.000Z",
      lastSeenAt: "2026-07-23T00:00:00.000Z",
      localProjectId: "local-project",
      displayName: "Koed",
      repository,
      path: { cwd: "/tmp/project", projectRoot: "/tmp/project" },
      git: {
        branch: "main",
        isWorktree: false,
        remotes: [{ display: "github.com/koed-labs/koed" }]
      }
    };
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => {
          await Promise.resolve();
          return [source];
        }),
        listProjectMetadata: vi.fn(async () => {
          return [metadata];
        })
      })
    );

    const snapshot = await store.loadProjects();

    expect(
      snapshot.projectsById.get(repositoryScopeId(repository))
    ).toMatchObject({
      name: "Koed",
      remoteDisplay: "github.com/koed-labs/koed",
      branch: "main"
    });
  });

  it("renders graph Projects when optional local metadata is unavailable", async () => {
    const source = project([thread(1)]);
    const store = new PersonalMemoryStore(
      api({
        listProjects: vi.fn(async () => [source]),
        listProjectMetadata: vi.fn(async () => {
          throw new Error("projects.json is unreadable");
        })
      })
    );

    const snapshot = await store.loadProjects();

    expect(snapshot.error).toBeNull();
    expect(snapshot.projectsById.get(source.id)).toMatchObject(source);
  });

  it("normalizes project shells and preserves unchanged project references", async () => {
    const threads = [thread(1), thread(2)];
    const source = project(threads);
    const bridge = api({ listProjects: vi.fn(async () => [source]) });
    const store = new PersonalMemoryStore(bridge);
    const first = await store.loadProjects();
    const firstProject = first.projectsById.get(source.id);
    const second = await store.loadProjects();

    expect(second.projectsById.get(source.id)).toBe(firstProject);
    expect(second.threadsByKey.size).toBe(2);
  });

  it("keeps a newly established managed Conversation in project navigation", async () => {
    const original = thread(1);
    const store = new PersonalMemoryStore(
      api({ listProjects: vi.fn(async () => [project([original])]) })
    );
    await store.loadProjects();
    const managed = {
      ...thread(2),
      sessionId: "00000000-0000-4000-8000-000000000002",
      latestAt: "2026-07-23T00:01:00.000Z"
    };

    store.upsertThread(managed);

    expect(store.current().projectsById.get("project")?.threads).toEqual([
      managed,
      original
    ]);
    expect(
      store.current().threadsByKey.get(personalMemoryThreadKey(managed))
    ).toBe(managed);
  });

  it("loads a warm head once and pages older events without duplicates", async () => {
    const selected = thread(1);
    const loadEventPage = vi
      .fn<PersonalDesktopApi["loadEventPage"]>()
      .mockResolvedValueOnce([event(50), event(51)])
      .mockResolvedValueOnce([event(49), event(50)]);
    const store = new PersonalMemoryStore(api({ loadEventPage }));

    const first = await store.loadInitial(selected);
    const warm = await store.loadInitial(selected);
    expect(warm).toBe(first);
    expect(loadEventPage).toHaveBeenCalledTimes(1);

    const paged = await store.loadOlder(selected);
    expect(paged.events.map(({ sourceSequence }) => sourceSequence)).toEqual([
      49, 50, 51
    ]);
    expect(paged.hasOlder).toBe(false);
  });

  it("bounds and concurrency-limits prewarming", async () => {
    const resolvers: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const loadEventPage = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active -= 1;
      return [];
    });
    const store = new PersonalMemoryStore(api({ loadEventPage }));
    store.prewarm(
      Array.from({ length: personalMemoryPrewarmLimit + 5 }, (_, index) =>
        thread(index)
      )
    );
    await vi.waitFor(() =>
      expect(loadEventPage).toHaveBeenCalledTimes(
        personalMemoryPrewarmConcurrency
      )
    );
    while (loadEventPage.mock.calls.length < personalMemoryPrewarmLimit) {
      while (resolvers.length > 0) resolvers.shift()!();
      const expected = Math.min(
        personalMemoryPrewarmLimit,
        loadEventPage.mock.calls.length + personalMemoryPrewarmConcurrency
      );
      await vi.waitFor(() =>
        expect(loadEventPage.mock.calls.length).toBeGreaterThanOrEqual(expected)
      );
    }
    while (resolvers.length > 0) resolvers.shift()!();
    await vi.waitFor(() => expect(active).toBe(0));
    expect(maxActive).toBe(personalMemoryPrewarmConcurrency);
  });

  it("purges protected detail and keeps the cache bounded", async () => {
    const loadEventPage = vi.fn(async () => []);
    const store = new PersonalMemoryStore(api({ loadEventPage }));
    for (let index = 0; index < personalMemoryCacheLimit + 8; index += 1) {
      await store.loadInitial(thread(index));
    }
    const retained = Array.from(
      { length: personalMemoryCacheLimit + 8 },
      (_, index) => store.detail(thread(index))
    ).filter(Boolean);
    expect(retained.length).toBeLessThanOrEqual(personalMemoryCacheLimit);

    store.purge(({ thread: cached }) => cached.projectId === "project");
    expect(store.detail(thread(personalMemoryCacheLimit + 7))).toBeNull();
  });

  it("refreshes the affected conversation and its navigation summary", async () => {
    let onChange: ((change: PersonalDesktopChange) => void) | undefined;
    const initialThread = thread(1);
    const updatedThread = {
      ...initialThread,
      eventCount: 101,
      latestAt: "2026-07-23T00:01:00.000Z"
    };
    const listProjects = vi
      .fn<PersonalDesktopApi["listProjects"]>()
      .mockResolvedValueOnce([project([initialThread])])
      .mockResolvedValue([project([updatedThread])]);
    const loadEventPage = vi
      .fn<PersonalDesktopApi["loadEventPage"]>()
      .mockResolvedValueOnce([event(1)])
      .mockResolvedValue([event(2)]);
    const bridge = api({
      listProjects,
      loadEventPage,
      subscribe: vi.fn((listener) => {
        onChange = listener;
        return () => undefined;
      })
    });
    const store = new PersonalMemoryStore(bridge);
    await store.loadProjects();
    await store.loadInitial(initialThread);
    expect(store.detail(initialThread)).not.toBeNull();

    const change: PersonalDesktopChange = {
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000100",
          projectId: initialThread.projectId,
          sourceTable: "messages",
          threadId: initialThread.id
        }
      ]
    };
    onChange?.(change);
    onChange?.({
      ...change,
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000101",
          projectId: initialThread.projectId,
          sourceTable: "messages",
          threadId: initialThread.id
        }
      ]
    });

    await vi.waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(loadEventPage).toHaveBeenCalledTimes(2));
    expect(
      store.current().threadsByKey.get(personalMemoryThreadKey(initialThread))
    ).toMatchObject({
      eventCount: updatedThread.eventCount,
      latestAt: updatedThread.latestAt
    });
    expect(
      store
        .detail(updatedThread)
        ?.events.map(({ sourceSequence }) => sourceSequence)
    ).toEqual([1, 2]);
  });

  it("removes a changed cached event omitted from the authoritative refresh", async () => {
    let onChange: ((change: PersonalDesktopChange) => void) | undefined;
    const selected = thread(1);
    const updated = {
      ...selected,
      eventCount: 2,
      invalidatedCount: 1
    };
    const loadEventPage = vi
      .fn<PersonalDesktopApi["loadEventPage"]>()
      .mockResolvedValueOnce([event(1), event(2)])
      .mockResolvedValueOnce([event(2), event(3)])
      .mockResolvedValueOnce([]);
    const bridge = api({
      listProjects: vi
        .fn<PersonalDesktopApi["listProjects"]>()
        .mockResolvedValueOnce([project([selected])])
        .mockResolvedValue([project([updated])]),
      loadEventPage,
      subscribe: vi.fn((listener) => {
        onChange = listener;
        return () => undefined;
      })
    });
    const store = new PersonalMemoryStore(bridge);
    await store.loadProjects();
    await store.loadInitial(selected);

    onChange?.({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: event(1).id,
          projectId: selected.projectId,
          sourceTable: "messages",
          threadId: selected.id
        }
      ]
    });

    await vi.waitFor(() =>
      expect(
        store
          .detail(updated)
          ?.events.map(({ sourceSequence }) => sourceSequence)
      ).toEqual([2, 3])
    );
    expect(loadEventPage).toHaveBeenLastCalledWith({
      projectId: selected.projectId,
      threadId: selected.id,
      limit: 500,
      eventIds: [event(1).id]
    });
  });

  it("reconciles a valid changed event outside the refreshed head", async () => {
    let onChange: ((change: PersonalDesktopChange) => void) | undefined;
    const selected = thread(1);
    const changedOlder = {
      ...event(1),
      content: "Updated older event",
      contentPreview: "Updated older event"
    };
    const loadEventPage = vi
      .fn<PersonalDesktopApi["loadEventPage"]>()
      .mockResolvedValueOnce([event(50), event(51)])
      .mockResolvedValueOnce([event(1), event(2)])
      .mockResolvedValueOnce([changedOlder]);
    const bridge = api({
      listProjects: vi.fn(async () => [project([selected])]),
      loadEventPage,
      subscribe: vi.fn((listener) => {
        onChange = listener;
        return () => undefined;
      })
    });
    const store = new PersonalMemoryStore(bridge);
    await store.loadProjects();
    await store.loadInitial(selected);
    await store.loadOlder(selected);

    onChange?.({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: changedOlder.id,
          projectId: selected.projectId,
          sourceTable: "messages",
          threadId: selected.id
        }
      ]
    });

    await vi.waitFor(() =>
      expect(
        store.detail(selected)?.events.find(({ id }) => id === changedOlder.id)
      ).toMatchObject({ content: "Updated older event" })
    );
    expect(loadEventPage).toHaveBeenLastCalledWith({
      projectId: selected.projectId,
      threadId: selected.id,
      limit: 500,
      eventIds: [changedOlder.id]
    });
  });

  it("keeps visible events mounted while refreshing the live head", async () => {
    let onChange: ((change: PersonalDesktopChange) => void) | undefined;
    let resolveRefresh:
      | ((events: PersonalDesktopConversationEvent[]) => void)
      | undefined;
    const selected = thread(1);
    const updated = { ...selected, eventCount: 101 };
    const loadEventPage = vi
      .fn<PersonalDesktopApi["loadEventPage"]>()
      .mockResolvedValueOnce([event(1)])
      .mockImplementationOnce(
        () =>
          new Promise<PersonalDesktopConversationEvent[]>((resolve) => {
            resolveRefresh = resolve;
          })
      );
    const bridge = api({
      listProjects: vi
        .fn<PersonalDesktopApi["listProjects"]>()
        .mockResolvedValueOnce([project([selected])])
        .mockResolvedValue([project([updated])]),
      loadEventPage,
      subscribe: vi.fn((listener) => {
        onChange = listener;
        return () => undefined;
      })
    });
    const store = new PersonalMemoryStore(bridge);
    await store.loadProjects();
    await store.loadInitial(selected);
    const observedEventCounts: number[] = [];
    const unsubscribe = store.subscribe(() => {
      observedEventCounts.push(store.detail(updated)?.events.length ?? 0);
    });

    onChange?.({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000100",
          projectId: selected.projectId,
          sourceTable: "messages",
          threadId: selected.id
        }
      ]
    });

    await vi.waitFor(() => expect(loadEventPage).toHaveBeenCalledTimes(2));
    expect(store.detail(updated)).toMatchObject({
      status: "ready",
      events: [expect.objectContaining({ sourceSequence: 1 })]
    });
    expect(observedEventCounts.every((count) => count > 0)).toBe(true);

    resolveRefresh?.([event(2)]);
    await vi.waitFor(() =>
      expect(
        store
          .detail(updated)
          ?.events.map(({ sourceSequence }) => sourceSequence)
      ).toEqual([1, 2])
    );
    expect(observedEventCounts.every((count) => count > 0)).toBe(true);
    unsubscribe();
  });

  it("preserves paged history when an older-page request wins a live-refresh race", async () => {
    let onChange: ((change: PersonalDesktopChange) => void) | undefined;
    let resolveRefresh:
      | ((events: PersonalDesktopConversationEvent[]) => void)
      | undefined;
    const selected = thread(1);
    const updated = { ...selected, eventCount: 102 };
    const loadEventPage = vi
      .fn<PersonalDesktopApi["loadEventPage"]>()
      .mockResolvedValueOnce([event(50), event(51)])
      .mockImplementationOnce(
        () =>
          new Promise<PersonalDesktopConversationEvent[]>((resolve) => {
            resolveRefresh = resolve;
          })
      )
      .mockResolvedValueOnce([event(49), event(50)]);
    const bridge = api({
      listProjects: vi
        .fn<PersonalDesktopApi["listProjects"]>()
        .mockResolvedValueOnce([project([selected])])
        .mockResolvedValue([project([updated])]),
      loadEventPage,
      subscribe: vi.fn((listener) => {
        onChange = listener;
        return () => undefined;
      })
    });
    const store = new PersonalMemoryStore(bridge);
    await store.loadProjects();
    await store.loadInitial(selected);

    onChange?.({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000052",
          projectId: selected.projectId,
          sourceTable: "messages",
          threadId: selected.id
        }
      ]
    });
    await vi.waitFor(() => expect(loadEventPage).toHaveBeenCalledTimes(2));

    const older = store.loadOlder(updated);
    await older;
    expect(store.detail(updated)).toMatchObject({ status: "ready" });
    expect(
      store.detail(updated)?.events.map(({ sourceSequence }) => sourceSequence)
    ).toEqual([49, 50, 51]);

    resolveRefresh?.([event(51), event(52)]);
    await vi.waitFor(() =>
      expect(
        store
          .detail(updated)
          ?.events.map(({ sourceSequence }) => sourceSequence)
      ).toEqual([49, 50, 51, 52])
    );
  });

  it("keeps pagination loading until it wins a live-refresh race", async () => {
    let onChange: ((change: PersonalDesktopChange) => void) | undefined;
    let resolveRefresh:
      | ((events: PersonalDesktopConversationEvent[]) => void)
      | undefined;
    let resolveOlder:
      | ((events: PersonalDesktopConversationEvent[]) => void)
      | undefined;
    const selected = thread(1);
    const updated = { ...selected, eventCount: 102 };
    const loadEventPage = vi
      .fn<PersonalDesktopApi["loadEventPage"]>()
      .mockResolvedValueOnce([event(50), event(51)])
      .mockImplementationOnce(
        () =>
          new Promise<PersonalDesktopConversationEvent[]>((resolve) => {
            resolveRefresh = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<PersonalDesktopConversationEvent[]>((resolve) => {
            resolveOlder = resolve;
          })
      );
    const bridge = api({
      listProjects: vi
        .fn<PersonalDesktopApi["listProjects"]>()
        .mockResolvedValueOnce([project([selected])])
        .mockResolvedValue([project([updated])]),
      loadEventPage,
      subscribe: vi.fn((listener) => {
        onChange = listener;
        return () => undefined;
      })
    });
    const store = new PersonalMemoryStore(bridge);
    await store.loadProjects();
    await store.loadInitial(selected);

    onChange?.({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000052",
          projectId: selected.projectId,
          sourceTable: "messages",
          threadId: selected.id
        }
      ]
    });
    await vi.waitFor(() => expect(loadEventPage).toHaveBeenCalledTimes(2));
    const older = store.loadOlder(updated);
    await vi.waitFor(() => expect(loadEventPage).toHaveBeenCalledTimes(3));

    resolveRefresh?.([event(51), event(52)]);
    await vi.waitFor(() =>
      expect(store.detail(updated)).toMatchObject({
        status: "loading",
        events: [
          expect.objectContaining({ sourceSequence: 50 }),
          expect.objectContaining({ sourceSequence: 51 }),
          expect.objectContaining({ sourceSequence: 52 })
        ]
      })
    );

    resolveOlder?.([event(49), event(50)]);
    await older;
    expect(store.detail(updated)).toMatchObject({ status: "ready" });
    expect(
      store.detail(updated)?.events.map(({ sourceSequence }) => sourceSequence)
    ).toEqual([49, 50, 51, 52]);
  });

  it("retains and retries a failed live-detail refresh", async () => {
    let onChange: ((change: PersonalDesktopChange) => void) | undefined;
    const selected = thread(1);
    const updated = { ...selected, eventCount: 101 };
    const loadEventPage = vi
      .fn<PersonalDesktopApi["loadEventPage"]>()
      .mockResolvedValueOnce([event(1)])
      .mockRejectedValueOnce(new Error("temporary refresh failure"))
      .mockResolvedValueOnce([event(2)]);
    const bridge = api({
      listProjects: vi
        .fn<PersonalDesktopApi["listProjects"]>()
        .mockResolvedValueOnce([project([selected])])
        .mockResolvedValue([project([updated])]),
      loadEventPage,
      subscribe: vi.fn((listener) => {
        onChange = listener;
        return () => undefined;
      })
    });
    const store = new PersonalMemoryStore(bridge, 0);
    await store.loadProjects();
    await store.loadInitial(selected);

    onChange?.({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000100",
          projectId: selected.projectId,
          sourceTable: "messages",
          threadId: selected.id
        }
      ]
    });

    await vi.waitFor(() => expect(loadEventPage).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(store.detail(updated)).toMatchObject({
        status: "ready",
        error: null,
        events: [
          expect.objectContaining({ sourceSequence: 1 }),
          expect.objectContaining({ sourceSequence: 2 })
        ]
      })
    );
  });

  it("refreshes again when a live change arrives during a detail request", async () => {
    let onChange: ((change: PersonalDesktopChange) => void) | undefined;
    const deferred: {
      resolve?: (events: PersonalDesktopConversationEvent[]) => void;
    } = {};
    const selected = thread(1);
    const updated = { ...selected, eventCount: 101 };
    const loadEventPage = vi
      .fn<PersonalDesktopApi["loadEventPage"]>()
      .mockImplementationOnce(
        () =>
          new Promise<PersonalDesktopConversationEvent[]>((resolve) => {
            deferred.resolve = resolve;
          })
      )
      .mockResolvedValueOnce([event(2)]);
    const bridge = api({
      listProjects: vi
        .fn<PersonalDesktopApi["listProjects"]>()
        .mockResolvedValueOnce([project([selected])])
        .mockResolvedValue([project([updated])]),
      loadEventPage,
      subscribe: vi.fn((listener) => {
        onChange = listener;
        return () => undefined;
      })
    });
    const store = new PersonalMemoryStore(bridge);
    await store.loadProjects();
    const initialLoad = store.loadInitial(selected);
    await vi.waitFor(() => expect(loadEventPage).toHaveBeenCalledTimes(1));

    onChange?.({
      contractVersion: PERSONAL_DESKTOP_CONTRACT_VERSION,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000100",
          projectId: selected.projectId,
          sourceTable: "messages",
          threadId: selected.id
        }
      ]
    });
    deferred.resolve?.([event(1)]);
    await initialLoad;

    await vi.waitFor(() => expect(loadEventPage).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        store
          .detail(updated)
          ?.events.map(({ sourceSequence }) => sourceSequence)
      ).toEqual([1, 2])
    );
  });
});
