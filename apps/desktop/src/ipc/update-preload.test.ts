import { describe, expect, it, vi } from "vitest";
import {
  desktopUpdateCommandChannel,
  desktopUpdateEventChannel
} from "@koed/shared/desktop-update-contract";
import { createDesktopUpdatePreloadApi } from "./update-preload.js";

const state = {
  installedVersion: "0.8.1",
  status: "idle",
  release: null,
  checkedAt: null
};
const fixture = () => {
  const listeners = new Set<(...args: unknown[]) => void>();
  const events = {
    on: vi.fn((_channel: string, listener: (...args: unknown[]) => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn(
      (_channel: string, listener: (...args: unknown[]) => void) => {
        listeners.delete(listener);
      }
    )
  };
  const invoke = vi.fn(
    async (channel: string, value: unknown): Promise<unknown> => {
      void channel;
      void value;
      return state;
    }
  );
  const api = createDesktopUpdatePreloadApi(invoke, events);
  return { listeners, events, invoke, api };
};

describe("Desktop update notice preload", () => {
  it("exposes frozen notice-only methods with validated responses", async () => {
    const f = fixture();
    expect(Object.isFrozen(f.api)).toBe(true);
    expect(Object.keys(f.api).sort()).toEqual([
      "checkForUpdates",
      "getState",
      "openReleasePage",
      "subscribe"
    ]);
    await f.api.getState();
    await f.api.checkForUpdates();
    await f.api.openReleasePage();
    expect(f.invoke.mock.calls).toEqual(
      ["get_state", "check", "open_release"].map((operation) => [
        desktopUpdateCommandChannel,
        { operation }
      ])
    );
    f.invoke.mockResolvedValueOnce({ ...state, secret: "x" });
    await expect(f.api.getState()).rejects.toThrow();
  });

  it("validates events and disposes only exact listener, including late events", () => {
    const f = fixture();
    const listener = vi.fn();
    const other = vi.fn();
    const unsubscribe = f.api.subscribe(listener);
    const wrapped = [...f.listeners][0]!;
    f.api.subscribe(other);
    expect(f.events.on).toHaveBeenCalledWith(
      desktopUpdateEventChannel,
      expect.any(Function)
    );
    wrapped({}, state);
    expect(listener).toHaveBeenCalledWith(state);
    expect(() => wrapped({}, { ...state, status: "installing" })).toThrow();
    unsubscribe();
    unsubscribe();
    wrapped({}, state);
    expect(listener).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(1);
    expect(f.events.removeListener).toHaveBeenCalledExactlyOnceWith(
      desktopUpdateEventChannel,
      wrapped
    );
    expect(() => f.api.subscribe(null as never)).toThrow();
  });
});
