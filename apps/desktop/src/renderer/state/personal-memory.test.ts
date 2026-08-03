import type {
  PersonalDesktopApi,
  PersonalDesktopChange,
  PersonalDesktopConversationEvent,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
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
  sample: `Sample ${index}`
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
    assignSessionProject: vi.fn(async () => ({ projectId: null })),
    subscribe: vi.fn(() => () => undefined),
    ...overrides
  }) satisfies PersonalDesktopApi;

describe("PersonalMemoryStore", () => {
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

  it("refreshes affected session state from a coalesced live change", async () => {
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
      contractVersion: 1,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000100",
          projectId: initialThread.projectId,
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
          threadId: initialThread.id
        }
      ]
    });

    await vi.waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(loadEventPage).toHaveBeenCalledTimes(2));
    expect(
      store.current().threadsByKey.get(personalMemoryThreadKey(updatedThread))
    ).toMatchObject({
      eventCount: 101,
      latestAt: "2026-07-23T00:01:00.000Z"
    });
    expect(
      store
        .detail(updatedThread)
        ?.events.map(({ sourceSequence }) => sourceSequence)
    ).toEqual([2]);
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
      contractVersion: 1,
      type: "conversation_events_changed",
      eventRefs: [
        {
          id: "00000000-0000-4000-8000-000000000100",
          projectId: selected.projectId,
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
      ).toEqual([2])
    );
  });
});
