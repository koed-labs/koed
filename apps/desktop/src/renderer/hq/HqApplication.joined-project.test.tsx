import { describe, expect, it, vi } from "vitest";
import {
  refreshJoinedProjectRoute,
  startOwnerSharingService
} from "./HqApplication.js";
import { SharingStore } from "./sharing/sharing-store.js";

describe("owner-scoped Sharing service", () => {
  it("keeps Sharing available for a Chief action on a conversation route and clears it on sign-out", async () => {
    const read = vi.fn(async () => ({
      backends: [
        {
          backendId: "team-a",
          status: "unavailable" as const,
          lastReachedAt: null,
          reason: "unreachable" as const
        }
      ]
    }));
    const store = new SharingStore({ read });
    const stop = startOwnerSharingService(store, "owner-a", "profile-a", true);
    await store.refresh();
    expect(store.current().overview?.backends[0]?.backendId).toBe("team-a");
    expect(read).toHaveBeenCalled();
    stop();
    expect(store.current().overview).toBeNull();
    startOwnerSharingService(store, null, null, false)();
    expect(store.current().ownerId).toBeNull();
    await store.refresh();
    expect(store.current().overview).toBeNull();
  });
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("accepted Project join navigation", () => {
  it("refreshes both Project stores and opens the Project for the same identity and route", async () => {
    const order: string[] = [];
    const opened = vi.fn(() => order.push("route"));
    const result = await refreshJoinedProjectRoute({
      isCurrent: () => true,
      refreshProjects: async () => {
        order.push("projects");
      },
      loadPersonalProjects: async () => {
        order.push("personal");
      },
      selectProject: opened
    });
    expect(result).toBe(true);
    expect(order).toEqual(["projects", "personal", "route"]);
    expect(opened).toHaveBeenCalledOnce();
  });

  it.each(["ownerId", "profileKey"] as const)(
    "does not load or navigate after a %s switch during the first refresh",
    async (changed) => {
      const first = deferred();
      const identity = {
        ownerId: "owner-a",
        profileKey: "profile-a",
        routeEpoch: 1
      };
      const expected = { ...identity };
      const loadPersonalProjects = vi.fn(async () => {});
      const selectProject = vi.fn();
      const pending = refreshJoinedProjectRoute({
        isCurrent: () =>
          identity.ownerId === expected.ownerId &&
          identity.profileKey === expected.profileKey &&
          identity.routeEpoch === expected.routeEpoch,
        refreshProjects: () => first.promise,
        loadPersonalProjects,
        selectProject
      });
      identity[changed] = "switched";
      first.resolve();
      expect(await pending).toBe(false);
      expect(loadPersonalProjects).not.toHaveBeenCalled();
      expect(selectProject).not.toHaveBeenCalled();
    }
  );

  it("does not overwrite manual navigation or a profile switch during the second refresh", async () => {
    for (const change of ["route", "profile"] as const) {
      const second = deferred();
      const identity = {
        ownerId: "owner-a",
        profileKey: "profile-a",
        routeEpoch: 1
      };
      const selectProject = vi.fn();
      const pending = refreshJoinedProjectRoute({
        isCurrent: () =>
          identity.ownerId === "owner-a" &&
          identity.profileKey === "profile-a" &&
          identity.routeEpoch === 1,
        refreshProjects: async () => {},
        loadPersonalProjects: () => second.promise,
        selectProject
      });
      if (change === "route") identity.routeEpoch++;
      else identity.profileKey = "profile-b";
      second.resolve();
      expect(await pending).toBe(false);
      expect(selectProject).not.toHaveBeenCalled();
    }
  });
});
