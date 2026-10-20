import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ProjectsStore } from "./useProjects.js";

const now = "2026-10-20T00:00:00.000Z";
const project = (id: string, version = 1) => ({
  id,
  name: "Atlas",
  key: "ATLAS",
  folderPath: null,
  lifecycle: "active" as const,
  deletionPhase: null,
  deleteBatchId: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  version
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("ProjectsStore", () => {
  it("clears old authority synchronously and ignores its delayed list", async () => {
    const old = deferred<ReturnType<typeof project>[]>();
    const current = project(randomUUID());
    const list = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([current]);
    const store = new ProjectsStore({ list, hq: vi.fn() });
    store.setOwner("owner", "profile-a");
    store.setOwner("owner", "profile-b");
    expect(store.current()).toMatchObject({
      profileKey: "profile-b",
      projects: []
    });
    old.resolve([project(randomUUID())]);
    await vi.waitFor(() => expect(store.current().projects).toEqual([current]));
  });

  it("refetches after an event racing a stale initial list, and reduces versions", async () => {
    const stale = deferred<ReturnType<typeof project>[]>();
    const id = randomUUID();
    const updated = project(id, 2);
    const list = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([updated])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([project(id, 4)]);
    const store = new ProjectsStore({ list, hq: vi.fn() });
    store.setOwner("owner", "profile-a");
    store.projectChanged("owner", "profile-a", id, updated);
    stale.resolve([project(id)]);
    await vi.waitFor(() => expect(store.current().projects).toEqual([updated]));
    store.projectChanged("owner", "profile-a", id, project(id));
    expect(store.current().projects).toEqual([updated]);
    store.projectChanged("owner", "profile-a", id, {
      ...updated,
      version: 3,
      lifecycle: "deleted",
      deletedAt: now
    });
    expect(store.current().projects).toEqual([]);
    await store.refresh();
    store.projectChanged("owner", "profile-a", id, updated);
    expect(store.current().projects).toEqual([]);
    store.projectChanged("owner", "profile-a", id, project(id, 4));
    await vi.waitFor(() =>
      expect(store.current().projects).toEqual([project(id, 4)])
    );
    store.projectChanged("owner", "profile-b", id, updated);
    expect(store.current().projects).toEqual([project(id, 4)]);
  });

  it("keeps a newer active event when a relist contains an older row", async () => {
    const id = randomUUID();
    const list = vi
      .fn()
      .mockResolvedValueOnce([project(id)])
      .mockResolvedValueOnce([project(id, 2)]);
    const store = new ProjectsStore({ list, hq: vi.fn() });
    store.setOwner("owner", "profile-a");
    await vi.waitFor(() => expect(store.current().loaded).toBe(true));
    const updated = { ...project(id, 3), name: "Atlas updated" };
    store.projectChanged("owner", "profile-a", id, updated);
    await store.refresh();
    expect(store.current().projects).toEqual([updated]);
  });

  it("keeps rename position and relists new rows in server microsecond order", async () => {
    const first = project(randomUUID());
    const second = project(randomUUID());
    const created = project(randomUUID());
    const renamed = { ...second, name: "Renamed", version: 2 };
    const later = deferred<ReturnType<typeof project>[]>();
    const list = vi
      .fn()
      .mockResolvedValueOnce([first, second])
      .mockReturnValueOnce(later.promise);
    const store = new ProjectsStore({ list, hq: vi.fn() });
    store.setOwner("owner", "profile-a");
    await vi.waitFor(() => expect(store.current().loaded).toBe(true));
    store.projectChanged("owner", "profile-a", second.id, renamed);
    expect(store.current().projects).toEqual([first, renamed]);
    store.projectChanged("owner", "profile-a", created.id, created);
    expect(store.current().projects).toEqual([first, renamed]);
    // All JSON timestamps tie; the API knows the original PostgreSQL order.
    later.resolve([created, first, renamed]);
    await vi.waitFor(() =>
      expect(store.current().projects).toEqual([created, first, renamed])
    );
    expect(list).toHaveBeenCalledTimes(2);
  });
});
