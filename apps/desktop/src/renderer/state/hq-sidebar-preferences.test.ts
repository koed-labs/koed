// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultHqSidebarPreferences,
  type HqSidebarPreferences,
  type HqSidebarPreferencesApi
} from "../../ipc/hq-sidebar-preferences-protocol.js";
import { HqSidebarPreferencesStore } from "./hq-sidebar-preferences.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("HQ sidebar preference renderer state", () => {
  afterEach(() => vi.useRealTimers());

  it("loads persisted groups and keeps user fold choices made before load", async () => {
    const pending = deferred<HqSidebarPreferences>();
    const set = vi.fn(async (value: HqSidebarPreferences) => value);
    const store = new HqSidebarPreferencesStore(
      { get: () => pending.promise, set },
      0
    );

    const loading = store.load();
    store.setGroupFolded("project:local-project-1", true);
    store.reconcileGroups(["just-me", "project:local-project-1"]);
    pending.resolve({ foldedGroups: { "just-me": true } });

    await expect(loading).resolves.toMatchObject({
      loading: false,
      foldedGroups: {
        "just-me": true,
        "project:local-project-1": true
      }
    });
    await store.flush();
    expect(set).toHaveBeenCalledWith({
      foldedGroups: {
        "just-me": true,
        "project:local-project-1": true
      }
    });
    expect(store.isGroupFolded("just-me")).toBe(true);
    store.dispose();
  });

  it("preserves an explicit unfold made before load", async () => {
    const pending = deferred<HqSidebarPreferences>();
    const set = vi.fn(async (value: HqSidebarPreferences) => value);
    const store = new HqSidebarPreferencesStore(
      { get: () => pending.promise, set },
      0
    );
    const loading = store.load();
    store.setGroupFolded("just-me", false);
    store.reconcileGroups(["just-me"]);
    pending.resolve({ foldedGroups: { "just-me": true } });

    await loading;
    await store.flush();
    expect(store.isGroupFolded("just-me")).toBe(false);
    expect(set).toHaveBeenCalledWith({ foldedGroups: {} });
    store.dispose();
  });

  it("serializes writes and flush waits for the newest fold state", async () => {
    vi.useFakeTimers();
    const first = deferred<HqSidebarPreferences>();
    const second = deferred<HqSidebarPreferences>();
    const set = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const api: HqSidebarPreferencesApi = {
      get: vi.fn(async () => defaultHqSidebarPreferences),
      set
    };
    const store = new HqSidebarPreferencesStore(api, 10);
    await store.load();
    store.reconcileGroups(["just-me", "project:local-project-1"]);

    store.setGroupFolded("just-me", true);
    const flushA = store.flush();
    store.setGroupFolded("project:local-project-1", true);
    let flushBSettled = false;
    const flushB = store.flush().then(() => {
      flushBSettled = true;
    });

    expect(set).toHaveBeenCalledOnce();
    first.resolve({ foldedGroups: { "just-me": true } });
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set).toHaveBeenNthCalledWith(2, {
      foldedGroups: { "just-me": true, "project:local-project-1": true }
    });
    expect(flushBSettled).toBe(false);
    second.resolve({
      foldedGroups: { "just-me": true, "project:local-project-1": true }
    });
    await Promise.all([flushA, flushB]);
    expect(flushBSettled).toBe(true);
    expect(store.current().foldedGroups).toEqual({
      "just-me": true,
      "project:local-project-1": true
    });
    store.dispose();
  });

  it("waits for an authoritative Projects list before pruning stored groups", async () => {
    const set = vi.fn(async (value: HqSidebarPreferences) => value);
    const store = new HqSidebarPreferencesStore(
      {
        get: vi.fn(async () => ({
          foldedGroups: { "project:previously-known": true }
        })),
        set
      },
      0
    );

    await store.load();
    expect(store.current().foldedGroups).toEqual({
      "project:previously-known": true
    });
    expect(set).not.toHaveBeenCalled();

    store.reconcileGroups(["just-me", "project:current"]);
    await store.flush();
    expect(store.current().foldedGroups).toEqual({});
    expect(set).toHaveBeenCalledWith({ foldedGroups: {} });
    store.dispose();
  });

  it("defers over-cap intent until a full group list can prune stale IDs", async () => {
    const staleProjectIds = Array.from(
      { length: 1001 },
      (_, index) => `project:stale-${index}`
    );
    const savedGroups = Object.fromEntries(
      staleProjectIds.map((groupId) => [groupId, true])
    );
    const set = vi.fn(async (value: HqSidebarPreferences) => value);
    const store = new HqSidebarPreferencesStore(
      {
        get: vi.fn(async () => ({ foldedGroups: savedGroups })),
        set
      },
      0
    );

    await store.load();
    expect(Object.keys(store.current().foldedGroups)).toHaveLength(1001);

    expect(() => store.setGroupFolded("project:interim", true)).not.toThrow();
    await store.flush();
    expect(set).not.toHaveBeenCalled();

    store.reconcileGroups(["just-me", "project:interim"]);
    await store.flush();
    expect(store.current().foldedGroups).toEqual({ "project:interim": true });
    expect(set).toHaveBeenCalledWith({
      foldedGroups: { "project:interim": true }
    });
    expect(Object.keys(set.mock.lastCall?.[0].foldedGroups ?? {}).length).toBe(
      1
    );
    store.dispose();
  });

  it("prunes departed Project IDs before persisting a newly folded Project", async () => {
    const staleProjectIds = Array.from(
      { length: 1000 },
      (_, index) => `project:stale-${index}`
    );
    const savedGroups = Object.fromEntries(
      [...staleProjectIds, "project:current"].map((groupId) => [groupId, true])
    );
    const set = vi.fn(async (value: HqSidebarPreferences) => value);
    const store = new HqSidebarPreferencesStore(
      {
        get: vi.fn(async () => ({ foldedGroups: savedGroups })),
        set
      },
      0
    );

    await store.load();
    expect(Object.keys(store.current().foldedGroups)).toHaveLength(1001);

    store.reconcileGroups(["just-me", "project:current", "project:new"]);
    store.setGroupFolded("project:new", true);
    await store.flush();

    expect(store.current().foldedGroups).toEqual({
      "project:current": true,
      "project:new": true
    });
    expect(set).toHaveBeenLastCalledWith({
      foldedGroups: { "project:current": true, "project:new": true }
    });
    expect(
      Object.keys(set.mock.lastCall?.[0].foldedGroups ?? {}).length
    ).toBeLessThanOrEqual(1001);
    store.dispose();
  });

  it("bounds saved groups plus valid pre-load fold intents to the native cap", async () => {
    const savedProjectIds = Array.from(
      { length: 1000 },
      (_, index) => `project:saved-${index}`
    );
    const newProjectIds = [...savedProjectIds, "project:new"];
    const savedGroups = Object.fromEntries(
      ["just-me", ...savedProjectIds].map((groupId) => [groupId, true])
    );
    const set = vi.fn(async (value: HqSidebarPreferences) => value);
    const store = new HqSidebarPreferencesStore(
      {
        get: vi.fn(async () => ({ foldedGroups: savedGroups })),
        set
      },
      0
    );

    store.reconcileGroups(["just-me", ...newProjectIds]);
    store.setGroupFolded("project:new", true);
    await store.load();
    await store.flush();

    expect(store.isGroupFolded("project:new")).toBe(true);
    expect(Object.keys(store.current().foldedGroups)).toHaveLength(1001);
    expect(Object.keys(store.current().foldedGroups)).not.toContain(
      "project:saved-999"
    );
    expect(Object.keys(set.mock.lastCall?.[0].foldedGroups ?? {}).length).toBe(
      1001
    );
    store.dispose();
  });
});
