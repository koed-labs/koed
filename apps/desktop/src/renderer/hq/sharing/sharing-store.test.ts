import { describe, expect, it, vi } from "vitest";
import type { SharingOverview } from "@koed/shared";
import type { SharingDesktopApi } from "../../../ipc/sharing-protocol.js";
import { SharingStore } from "./sharing-store.js";

const overview: SharingOverview = {
  backends: [
    {
      backendId: "team-a",
      status: "unavailable",
      lastReachedAt: null,
      reason: "unreachable"
    }
  ]
};

describe("Sharing store", () => {
  it("clears old owner data and ignores a completed read from the previous profile", async () => {
    let release!: (value: SharingOverview) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SharingOverview>((resolve) => {
            release = resolve;
          })
      )
      .mockResolvedValueOnce({ backends: [] });
    const store = new SharingStore({ read } as SharingDesktopApi);
    store.setOwner("owner-a", "profile-a");
    store.start();
    store.setOwner("owner-b", "profile-b");
    release(overview);
    await Promise.resolve();
    expect(store.current().ownerId).toBe("owner-b");
    expect(store.current().overview).not.toEqual(overview);
    await store.refresh();
    expect(store.current().overview).toEqual({ backends: [] });
    store.stop();
    expect(store.current().overview).toBeNull();
  });
  it("exposes unavailable backends without dropping them", async () => {
    const store = new SharingStore({ read: async () => overview });
    store.setOwner("owner-a", "profile-a");
    store.start();
    await store.refresh();
    expect(store.current().overview?.backends[0]?.status).toBe("unavailable");
    store.stop();
  });
  it("queues one refresh for collaboration invalidations received during a read", async () => {
    let release!: (value: SharingOverview) => void;
    const eventListener: { current?: () => void } = {};
    const unsubscribe = vi.fn();
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SharingOverview>((resolve) => {
            release = resolve;
          })
      )
      .mockResolvedValueOnce({ backends: [] });
    const store = new SharingStore(
      { read },
      {
        subscribe: (listener) => {
          eventListener.current = () => listener({} as never);
          return unsubscribe;
        }
      }
    );
    store.setOwner("owner-a", "profile-a");
    store.start();
    eventListener.current?.();
    eventListener.current?.();
    release(overview);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.current().overview).toEqual({ backends: [] });
    store.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
