import { describe, expect, it, vi } from "vitest";

import {
  defaultHqSidebarPreferences,
  hqSidebarPreferencesGetChannel,
  hqSidebarPreferencesSetChannel
} from "./hq-sidebar-preferences-protocol.js";
import { createHqSidebarPreferencesPreloadApi } from "./hq-sidebar-preferences-preload.js";

describe("HQ sidebar preferences preload API", () => {
  it("validates the response from get", async () => {
    const invoke = vi.fn(async () => defaultHqSidebarPreferences);
    const api = createHqSidebarPreferencesPreloadApi(invoke);

    await expect(api.get()).resolves.toEqual(defaultHqSidebarPreferences);
    expect(invoke).toHaveBeenCalledWith(hqSidebarPreferencesGetChannel);
  });

  it("validates set input and response on both sides of IPC", async () => {
    const invoke = vi.fn(async (_channel: string, value: unknown) => value);
    const api = createHqSidebarPreferencesPreloadApi(invoke);
    const value = {
      foldedGroups: { "just-me": true, "project:local-project-1": false }
    };

    await expect(api.set(value)).resolves.toEqual(value);
    expect(invoke).toHaveBeenCalledWith(hqSidebarPreferencesSetChannel, value);
    const setUnchecked = api.set as unknown as (
      input: unknown
    ) => Promise<unknown>;
    await expect(setUnchecked({ ...value, extra: true })).rejects.toThrow();
    await expect(
      setUnchecked({ foldedGroups: { "just-me": "folded" } })
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("rejects malformed results and extra arguments", async () => {
    const api = createHqSidebarPreferencesPreloadApi(
      vi.fn(async () => ({ foldedGroups: {}, extra: true }))
    );
    await expect(api.get()).rejects.toThrow();

    const valid = createHqSidebarPreferencesPreloadApi(
      vi.fn(async () => defaultHqSidebarPreferences)
    );
    const get = valid.get as (...args: unknown[]) => Promise<unknown>;
    const set = valid.set as (...args: unknown[]) => Promise<unknown>;
    await expect(get("unexpected")).rejects.toThrow();
    await expect(
      set(defaultHqSidebarPreferences, "unexpected")
    ).rejects.toThrow();
  });
});
