import { describe, expect, it, vi } from "vitest";
import {
  desktopUpdateCommandChannel,
  desktopUpdateEventChannel
} from "@koed-labs/shared/desktop-update-contract";
import { createDesktopUpdatePreloadApi } from "./update-preload.js";

const state = {
  installedVersion: "0.10.0",
  status: "idle" as const,
  release: null,
  checkedAt: null
};

describe("Desktop update preload API", () => {
  it("exposes only frozen state, check, open, and subscribe operations", async () => {
    const invoke = vi.fn(async () => state);
    const events = { on: vi.fn(), removeListener: vi.fn() };
    const api = createDesktopUpdatePreloadApi(invoke, events);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual([
      "checkForUpdates",
      "getState",
      "openReleasePage",
      "subscribe"
    ]);
    await api.checkForUpdates();
    expect(invoke).toHaveBeenCalledWith(desktopUpdateCommandChannel, {
      operation: "check"
    });
    invoke.mockResolvedValueOnce({ ...state, surprise: true } as typeof state);
    await expect(api.getState()).rejects.toThrow();
  });

  it("validates state events, removes exact listener, and ignores late events", () => {
    let registered: ((...args: unknown[]) => void) | undefined;
    const events = {
      on: vi.fn((_channel: string, listener: (...args: unknown[]) => void) => {
        registered = listener;
      }),
      removeListener: vi.fn()
    };
    const api = createDesktopUpdatePreloadApi(
      vi.fn(async () => state),
      events
    );
    const listener = vi.fn(() => undefined);
    const unsubscribe = api.subscribe(listener);
    registered?.({}, state);
    registered?.({}, { ...state, status: "available" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(state);
    expect(events.on).toHaveBeenCalledWith(
      desktopUpdateEventChannel,
      registered
    );
    unsubscribe();
    registered?.({}, state);
    expect(listener).toHaveBeenCalledOnce();
    expect(events.removeListener).toHaveBeenCalledExactlyOnceWith(
      desktopUpdateEventChannel,
      registered
    );
  });
});
