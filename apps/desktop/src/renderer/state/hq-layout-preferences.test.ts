// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultHqLayoutPreferences,
  type HqLayoutPreferencesApi
} from "../../ipc/hq-layout-preferences-protocol.js";
import { HqLayoutPreferencesStore } from "./hq-layout-preferences.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

describe("HQ layout preference renderer state", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps user changes made during initial load while applying untouched fields", async () => {
    const pending = deferred<typeof defaultHqLayoutPreferences>();
    const api: HqLayoutPreferencesApi = {
      get: () => pending.promise,
      set: vi.fn(async (value) => value)
    };
    const store = new HqLayoutPreferencesStore(api, 0);
    const loading = store.load();

    store.setSidebarWidth(320);
    pending.resolve({
      sidebarWidth: 420,
      rightColumnWidth: 612,
      rightColumnHidden: true
    });

    await expect(loading).resolves.toMatchObject({
      loading: false,
      preferences: {
        sidebarWidth: 320,
        rightColumnWidth: 612,
        rightColumnHidden: true
      }
    });
    await vi.waitFor(() => expect(api.set).toHaveBeenCalledOnce());
    expect(api.set).toHaveBeenCalledWith({
      sidebarWidth: 320,
      rightColumnWidth: 612,
      rightColumnHidden: true
    });
    store.dispose();
  });

  it("keeps edits made before the first load starts", async () => {
    const pending = deferred<typeof defaultHqLayoutPreferences>();
    const set = vi.fn(async (value) => value);
    const api: HqLayoutPreferencesApi = {
      get: vi.fn(() => pending.promise),
      set
    };
    const store = new HqLayoutPreferencesStore(api, 120);

    store.setSidebarWidth(350);
    const flushing = store.flush();
    expect(api.get).toHaveBeenCalledOnce();
    expect(set).not.toHaveBeenCalled();

    pending.resolve({
      sidebarWidth: 268,
      rightColumnWidth: 612,
      rightColumnHidden: true
    });
    await flushing;

    expect(store.current().preferences).toEqual({
      sidebarWidth: 350,
      rightColumnWidth: 612,
      rightColumnHidden: true
    });
    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      sidebarWidth: 350,
      rightColumnWidth: 612,
      rightColumnHidden: true
    });
    store.dispose();
  });

  it("preserves an explicit default-width reset made before the first load", async () => {
    const pending = deferred<typeof defaultHqLayoutPreferences>();
    const set = vi.fn(async (value) => value);
    const store = new HqLayoutPreferencesStore(
      {
        get: () => pending.promise,
        set
      },
      120
    );

    store.setRightColumnWidth(null);
    const flushing = store.flush();
    pending.resolve({
      ...defaultHqLayoutPreferences,
      rightColumnWidth: 520
    });
    await flushing;

    expect(store.current().preferences.rightColumnWidth).toBeNull();
    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      ...defaultHqLayoutPreferences,
      rightColumnWidth: null
    });
    store.setRightColumnWidth(null);
    await store.flush();
    expect(set).toHaveBeenCalledOnce();
    store.dispose();
  });

  it("coalesces changes and serializes writes without stale responses reverting state", async () => {
    vi.useFakeTimers();
    const first = deferred<typeof defaultHqLayoutPreferences>();
    const second = deferred<typeof defaultHqLayoutPreferences>();
    const set = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const api: HqLayoutPreferencesApi = {
      get: vi.fn(async () => defaultHqLayoutPreferences),
      set
    };
    const store = new HqLayoutPreferencesStore(api, 20);
    await store.load();

    store.setSidebarWidth(300);
    store.setSidebarWidth(310);
    await vi.advanceTimersByTimeAsync(20);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenNthCalledWith(1, {
      ...defaultHqLayoutPreferences,
      sidebarWidth: 310
    });

    store.setSidebarWidth(330);
    await vi.advanceTimersByTimeAsync(20);
    expect(set).toHaveBeenCalledTimes(1);
    first.resolve({ ...defaultHqLayoutPreferences, sidebarWidth: 310 });
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set).toHaveBeenNthCalledWith(2, {
      ...defaultHqLayoutPreferences,
      sidebarWidth: 330
    });
    expect(store.current().preferences.sidebarWidth).toBe(330);

    second.resolve({ ...defaultHqLayoutPreferences, sidebarWidth: 330 });
    await vi.waitFor(() => expect(store.current().error).toBeNull());
    expect(store.current().preferences.sidebarWidth).toBe(330);
    store.dispose();
  });

  it("flushes the latest completed layout change before the debounce expires", async () => {
    vi.useFakeTimers();
    const set = vi.fn(async (value) => value);
    const store = new HqLayoutPreferencesStore(
      {
        get: vi.fn(async () => defaultHqLayoutPreferences),
        set
      },
      120
    );
    await store.load();

    store.setSidebarWidth(336);
    expect(set).not.toHaveBeenCalled();
    await store.flush();

    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      ...defaultHqLayoutPreferences,
      sidebarWidth: 336
    });
    expect(vi.getTimerCount()).toBe(0);
    store.dispose();
  });

  it("waits for a newer write already started by a concurrent flush", async () => {
    const first = deferred<typeof defaultHqLayoutPreferences>();
    const second = deferred<typeof defaultHqLayoutPreferences>();
    const set = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = new HqLayoutPreferencesStore(
      {
        get: vi.fn(async () => defaultHqLayoutPreferences),
        set
      },
      120
    );
    await store.load();

    store.setSidebarWidth(301);
    const flushA = store.flush();
    expect(set).toHaveBeenCalledOnce();

    store.setSidebarWidth(302);
    let flushBSettled = false;
    const flushB = store.flush().then(() => {
      flushBSettled = true;
    });

    first.resolve({ ...defaultHqLayoutPreferences, sidebarWidth: 301 });
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set).toHaveBeenNthCalledWith(2, {
      ...defaultHqLayoutPreferences,
      sidebarWidth: 302
    });
    expect(flushBSettled).toBe(false);

    second.resolve({ ...defaultHqLayoutPreferences, sidebarWidth: 302 });
    await Promise.all([flushA, flushB]);
    expect(flushBSettled).toBe(true);
    store.dispose();
  });

  it("waits for initial load before flushing edits made during the load", async () => {
    const pending = deferred<typeof defaultHqLayoutPreferences>();
    const set = vi.fn(async (value) => value);
    const store = new HqLayoutPreferencesStore(
      {
        get: () => pending.promise,
        set
      },
      120
    );
    const loading = store.load();
    store.setSidebarWidth(340);

    let flushSettled = false;
    const flushing = store.flush().then(() => {
      flushSettled = true;
    });
    await Promise.resolve();
    expect(set).not.toHaveBeenCalled();
    expect(flushSettled).toBe(false);

    pending.resolve({
      sidebarWidth: 420,
      rightColumnWidth: 612,
      rightColumnHidden: true
    });
    await loading;
    await flushing;

    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      sidebarWidth: 340,
      rightColumnWidth: 612,
      rightColumnHidden: true
    });
    store.dispose();
  });

  it("surfaces the newest write failure without changing the requested preferences", async () => {
    const api: HqLayoutPreferencesApi = {
      get: vi.fn(async () => defaultHqLayoutPreferences),
      set: vi.fn(async () => {
        throw new Error("Preferences could not be saved.");
      })
    };
    const store = new HqLayoutPreferencesStore(api, 0);
    await store.load();
    store.setRightColumnHidden(true);
    await vi.waitFor(() =>
      expect(store.current().error).toBe("Preferences could not be saved.")
    );
    expect(store.current().preferences.rightColumnHidden).toBe(true);
    store.dispose();
  });
});
