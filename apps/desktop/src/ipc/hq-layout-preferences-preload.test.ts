import { describe, expect, it, vi } from "vitest";

import {
  defaultHqLayoutPreferences,
  hqLayoutPreferencesGetChannel,
  hqLayoutPreferencesSetChannel
} from "./hq-layout-preferences-protocol.js";
import { createHqLayoutPreferencesPreloadApi } from "./hq-layout-preferences-preload.js";

describe("HQ layout preferences preload API", () => {
  it("validates and parses the response from get", async () => {
    const invoke = vi.fn(async () => defaultHqLayoutPreferences);
    const api = createHqLayoutPreferencesPreloadApi(invoke);

    await expect(api.get()).resolves.toEqual(defaultHqLayoutPreferences);
    expect(invoke).toHaveBeenCalledWith(hqLayoutPreferencesGetChannel);
  });

  it("validates set input and response on both sides of IPC", async () => {
    const invoke = vi.fn(async (_channel: string, value: unknown) => value);
    const api = createHqLayoutPreferencesPreloadApi(invoke);
    const value = {
      ...defaultHqLayoutPreferences,
      rightColumnWidth: 512,
      rightColumnHidden: true
    };

    await expect(api.set(value)).resolves.toEqual(value);
    expect(invoke).toHaveBeenCalledWith(hqLayoutPreferencesSetChannel, value);
    await expect(api.set({ ...value, sidebarWidth: 199 })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("rejects malformed main-process results", async () => {
    const api = createHqLayoutPreferencesPreloadApi(
      vi.fn(async () => ({ ...defaultHqLayoutPreferences, unknown: true }))
    );
    await expect(api.get()).rejects.toThrow();
  });

  it("rejects extra arguments for both methods", async () => {
    const api = createHqLayoutPreferencesPreloadApi(
      vi.fn(async () => defaultHqLayoutPreferences)
    );
    const get = api.get as (...args: unknown[]) => Promise<unknown>;
    const set = api.set as (...args: unknown[]) => Promise<unknown>;

    await expect(get("unexpected")).rejects.toThrow();
    await expect(
      set(defaultHqLayoutPreferences, "unexpected")
    ).rejects.toThrow();
  });
});
