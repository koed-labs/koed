import {
  PERSONAL_DESKTOP_INITIAL_EVENT_LIMIT,
  PERSONAL_DESKTOP_OLDER_EVENT_LIMIT,
  type PersonalDesktopApi,
  type PersonalDesktopConversationEvent,
  type PersonalDesktopProject,
  type PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";

import { mergeConversationEvents } from "../../desktop-conversation.js";

export const personalMemoryCacheLimit = 32;
export const personalMemoryCacheRetentionMs = 15 * 60 * 1000;
export const personalMemoryPrewarmLimit = 10;
export const personalMemoryPrewarmConcurrency = 2;

export type PersonalMemoryDetail = {
  events: PersonalDesktopConversationEvent[];
  error: string | null;
  hasOlder: boolean;
  lastAccessedAt: number;
  loadedAt: number;
  status: "idle" | "loading" | "ready" | "error";
  thread: PersonalDesktopProjectThread;
};

export type PersonalMemorySnapshot = {
  error: string | null;
  loading: boolean;
  projectOrder: string[];
  projectsById: ReadonlyMap<string, PersonalDesktopProject>;
  revision: number;
  threadsByKey: ReadonlyMap<string, PersonalDesktopProjectThread>;
};

export type PersonalMemoryListener = () => void;

export const personalMemoryThreadKey = (
  thread: Pick<PersonalDesktopProjectThread, "projectId" | "id">
): string => `${thread.projectId}:${thread.id}`;

const emptySnapshot = (): PersonalMemorySnapshot => ({
  error: null,
  loading: false,
  projectOrder: [],
  projectsById: new Map(),
  revision: 0,
  threadsByKey: new Map()
});

const eventCursor = (event: PersonalDesktopConversationEvent) => ({
  id: event.id,
  sourceSequence: event.sourceSequence,
  timestamp: event.timestamp
});

export class PersonalMemoryStore {
  readonly #api: PersonalDesktopApi;
  readonly #cache = new Map<string, PersonalMemoryDetail>();
  readonly #detailRefreshKeys = new Set<string>();
  readonly #listeners = new Set<PersonalMemoryListener>();
  readonly #prewarmQueued = new Set<string>();
  #snapshot = emptySnapshot();
  #projectRequest = 0;
  #prewarmActive = 0;
  #prewarmQueue: PersonalDesktopProjectThread[] = [];
  #liveRefreshAgain = false;
  #liveRefreshQueued = false;
  #liveRefreshRunning = false;

  constructor(api: PersonalDesktopApi) {
    this.#api = api;
    api.subscribe((change) => {
      for (const { projectId, threadId } of change.eventRefs) {
        this.#detailRefreshKeys.add(`${projectId}:${threadId}`);
      }
      this.#scheduleLiveRefresh();
    });
  }

  current = (): PersonalMemorySnapshot => this.#snapshot;

  subscribe = (listener: PersonalMemoryListener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  refreshFromDurableEvent = (): void => {
    this.#scheduleLiveRefresh();
  };

  detail(
    thread: Pick<PersonalDesktopProjectThread, "projectId" | "id">
  ): PersonalMemoryDetail | null {
    const entry = this.#cache.get(personalMemoryThreadKey(thread)) ?? null;
    if (entry) entry.lastAccessedAt = Date.now();
    return entry;
  }

  async loadProjects({
    silent = false
  }: {
    silent?: boolean;
  } = {}): Promise<PersonalMemorySnapshot> {
    const request = ++this.#projectRequest;
    if (!silent) {
      this.#replace({ ...this.#snapshot, loading: true, error: null });
    }
    try {
      const projects = await this.#api.listProjects();
      if (request !== this.#projectRequest) return this.#snapshot;
      const projectsById = new Map<string, PersonalDesktopProject>();
      const threadsByKey = new Map<string, PersonalDesktopProjectThread>();
      for (const project of projects) {
        const previous = this.#snapshot.projectsById.get(project.id);
        const stableProject =
          previous && JSON.stringify(previous) === JSON.stringify(project)
            ? previous
            : project;
        projectsById.set(project.id, stableProject);
        for (const thread of stableProject.threads) {
          threadsByKey.set(personalMemoryThreadKey(thread), thread);
        }
      }
      this.#replace({
        error: null,
        loading: false,
        projectOrder: projects.map(({ id }) => id),
        projectsById,
        revision: this.#snapshot.revision + 1,
        threadsByKey
      });
      this.#prune();
      return this.#snapshot;
    } catch (cause) {
      if (request !== this.#projectRequest) return this.#snapshot;
      this.#replace({
        ...this.#snapshot,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return this.#snapshot;
    }
  }

  #scheduleLiveRefresh(): void {
    if (this.#liveRefreshRunning) {
      this.#liveRefreshAgain = true;
      return;
    }
    if (this.#liveRefreshQueued) return;
    this.#liveRefreshQueued = true;
    queueMicrotask(() => {
      this.#liveRefreshQueued = false;
      void this.#runLiveRefresh();
    });
  }

  async #runLiveRefresh(): Promise<void> {
    if (this.#liveRefreshRunning) {
      this.#liveRefreshAgain = true;
      return;
    }
    this.#liveRefreshRunning = true;
    try {
      do {
        this.#liveRefreshAgain = false;
        await this.loadProjects({ silent: true });
        await this.#refreshChangedDetails();
      } while (this.#liveRefreshAgain);
    } finally {
      this.#liveRefreshRunning = false;
    }
  }

  async loadInitial(
    thread: PersonalDesktopProjectThread
  ): Promise<PersonalMemoryDetail> {
    const key = personalMemoryThreadKey(thread);
    const existing = this.#cache.get(key);
    const now = Date.now();
    if (
      existing?.status === "ready" &&
      now - existing.loadedAt < personalMemoryCacheRetentionMs
    ) {
      existing.lastAccessedAt = now;
      return existing;
    }
    if (existing?.status === "loading") return existing;

    const entry: PersonalMemoryDetail = existing ?? {
      events: [],
      error: null,
      hasOlder: false,
      lastAccessedAt: now,
      loadedAt: 0,
      status: "idle",
      thread
    };
    entry.thread = thread;
    entry.status = "loading";
    entry.error = null;
    entry.lastAccessedAt = now;
    this.#cache.set(key, entry);
    this.#emit();
    try {
      const events = await this.#api.loadEventPage({
        projectId: thread.projectId,
        threadId: thread.id,
        limit: PERSONAL_DESKTOP_INITIAL_EVENT_LIMIT
      });
      if (this.#cache.get(key) !== entry) return entry;
      entry.events = mergeConversationEvents([], events);
      entry.hasOlder = entry.events.length < thread.eventCount;
      entry.loadedAt = Date.now();
      entry.status = "ready";
      entry.error = null;
    } catch (cause) {
      if (this.#cache.get(key) !== entry) return entry;
      entry.status = "error";
      entry.error = cause instanceof Error ? cause.message : String(cause);
    }
    this.#prune(new Set([key]));
    this.#emit();
    if (this.#detailRefreshKeys.has(key)) this.#scheduleLiveRefresh();
    return entry;
  }

  async #refreshChangedDetails(): Promise<void> {
    for (const key of [...this.#detailRefreshKeys]) {
      const entry = this.#cache.get(key);
      if (!entry) {
        this.#detailRefreshKeys.delete(key);
        continue;
      }
      if (entry.status === "loading") continue;
      const thread = this.#snapshot.threadsByKey.get(key);
      this.#detailRefreshKeys.delete(key);
      if (!thread) {
        this.#cache.delete(key);
        this.#emit();
        continue;
      }
      this.#cache.delete(key);
      await this.loadInitial(thread);
    }
  }

  async loadOlder(
    thread: PersonalDesktopProjectThread
  ): Promise<PersonalMemoryDetail> {
    const key = personalMemoryThreadKey(thread);
    const entry = this.#cache.get(key) ?? (await this.loadInitial(thread));
    const cursor = entry.events[0];
    if (
      entry.status === "loading" ||
      !entry.hasOlder ||
      !cursor ||
      this.#cache.get(key) !== entry
    ) {
      return entry;
    }
    entry.status = "loading";
    entry.error = null;
    this.#emit();
    try {
      const older = await this.#api.loadEventPage({
        projectId: thread.projectId,
        threadId: thread.id,
        limit: PERSONAL_DESKTOP_OLDER_EVENT_LIMIT,
        cursor: eventCursor(cursor)
      });
      if (this.#cache.get(key) !== entry) return entry;
      const previousCount = entry.events.length;
      const repeatedCursor = older.some(({ id }) => id === cursor.id);
      entry.events = mergeConversationEvents(entry.events, older);
      entry.hasOlder =
        !repeatedCursor &&
        entry.events.length > previousCount &&
        entry.events.length < thread.eventCount;
      entry.loadedAt = Date.now();
      entry.status = "ready";
    } catch (cause) {
      if (this.#cache.get(key) !== entry) return entry;
      entry.status = "error";
      entry.error = cause instanceof Error ? cause.message : String(cause);
    }
    this.#emit();
    return entry;
  }

  prewarm(
    threads: PersonalDesktopProjectThread[],
    protectedThread?: PersonalDesktopProjectThread
  ): void {
    const protectedKey = protectedThread
      ? personalMemoryThreadKey(protectedThread)
      : null;
    for (const thread of threads.slice(0, personalMemoryPrewarmLimit)) {
      const key = personalMemoryThreadKey(thread);
      if (
        key === protectedKey ||
        this.#prewarmQueued.has(key) ||
        this.#cache.get(key)?.status === "ready"
      ) {
        continue;
      }
      this.#prewarmQueued.add(key);
      this.#prewarmQueue.push(thread);
    }
    this.#drainPrewarm();
  }

  purge(predicate: (detail: PersonalMemoryDetail) => boolean): void {
    for (const [key, detail] of this.#cache) {
      if (predicate(detail)) this.#cache.delete(key);
    }
    this.#emit();
  }

  #drainPrewarm(): void {
    while (
      this.#prewarmActive < personalMemoryPrewarmConcurrency &&
      this.#prewarmQueue.length > 0
    ) {
      const thread = this.#prewarmQueue.shift()!;
      const key = personalMemoryThreadKey(thread);
      this.#prewarmActive += 1;
      void this.loadInitial(thread).finally(() => {
        this.#prewarmQueued.delete(key);
        this.#prewarmActive -= 1;
        this.#drainPrewarm();
      });
    }
  }

  #prune(protectedKeys = new Set<string>()): void {
    const now = Date.now();
    for (const [key, entry] of this.#cache) {
      if (
        !protectedKeys.has(key) &&
        entry.status !== "loading" &&
        now - entry.lastAccessedAt > personalMemoryCacheRetentionMs
      ) {
        this.#cache.delete(key);
      }
    }
    if (this.#cache.size <= personalMemoryCacheLimit) return;
    const removable = [...this.#cache.entries()]
      .filter(
        ([key, entry]) => !protectedKeys.has(key) && entry.status !== "loading"
      )
      .sort(
        ([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt
      );
    for (const [key] of removable) {
      if (this.#cache.size <= personalMemoryCacheLimit) break;
      this.#cache.delete(key);
    }
  }

  #replace(snapshot: PersonalMemorySnapshot): void {
    this.#snapshot = snapshot;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
