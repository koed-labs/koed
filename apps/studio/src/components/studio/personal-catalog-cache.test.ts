import { describe, expect, it } from "vitest";

import {
  createPersonalCatalogCacheStore,
  PERSONAL_CATALOG_CACHE_MAX_AGE_MS,
  personalCatalogOwnerId,
  persistPersonalCatalogRemovals,
  persistPersonalCatalogSnapshot
} from "./personal-catalog-cache";
import { hasConversationRemoval } from "./personal-removals-view";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
}

const sample = (scopeKey: string, cachedAt: number) => ({
  schemaVersion: 1 as const,
  scopeKey,
  cachedAt,
  provider: "all" as const,
  catalog: {
    items: [{ sourceId: "source-1", provider: "codex", title: "A chat" }],
    providers: { codex: { status: "available" } },
    truncated: false
  },
  projects: [{ id: "project-1", name: "Project" }],
  removals: [{ kind: "conversation" as const, sourceId: "old-source" }]
});

describe("Personal catalog cache", () => {
  it("round trips a versioned cache under its verified account scope", async () => {
    const storage = memoryStorage();
    const store = createPersonalCatalogCacheStore({
      ownerId: "owner-1",
      scopeKey: "http://127.0.0.1:43000|owner-1",
      storage,
      now: () => 50_000
    });
    expect(store).not.toBeNull();
    const value = sample("http://127.0.0.1:43000|owner-1", 49_000);
    await store!.write(value);
    await expect(store!.read()).resolves.toEqual(value);
    await store!.clear();
    await expect(store!.read()).resolves.toBeNull();
  });

  it("does not construct a cache until the owner matches the verified scope", () => {
    expect(
      createPersonalCatalogCacheStore({
        ownerId: "owner-2",
        scopeKey: "http://127.0.0.1:43000|owner-1",
        storage: memoryStorage()
      })
    ).toBeNull();
    expect(personalCatalogOwnerId("http://127.0.0.1:43000|owner-1")).toBe(
      "owner-1"
    );
    expect(personalCatalogOwnerId(null)).toBeNull();
  });

  it("rejects corrupt, stale, cross-account, and oversized cache records", async () => {
    const storage = memoryStorage();
    const scopeKey = "http://127.0.0.1:43000|owner-1";
    const store = createPersonalCatalogCacheStore({
      ownerId: "owner-1",
      scopeKey,
      storage,
      now: () => 100_000
    })!;
    await store.write(sample(scopeKey, 99_000));
    const key = [...storage.values.keys()][0] ?? "";
    storage.setItem(key, "not-json");
    await expect(store.read()).resolves.toBeNull();
    await store.write(sample("http://127.0.0.1:43000|owner-2", 99_000));
    await expect(store.read()).resolves.toBeNull();
    await store.write(
      sample(scopeKey, 100_000 - PERSONAL_CATALOG_CACHE_MAX_AGE_MS - 1)
    );
    await expect(store.read()).resolves.toBeNull();
    storage.setItem(key, "x".repeat(1_000_001));
    await expect(store.read()).resolves.toBeNull();
  });

  it("treats blocked storage as a best-effort cache miss", async () => {
    const store = createPersonalCatalogCacheStore({
      ownerId: "owner-1",
      scopeKey: "http://127.0.0.1:43000|owner-1",
      storage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("quota");
        },
        removeItem: () => {
          throw new Error("blocked");
        }
      }
    })!;
    await expect(store.read()).resolves.toBeNull();
    await expect(
      store.write(sample("http://127.0.0.1:43000|owner-1", 1))
    ).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it("keeps a completed removal when a catalog refresh writes concurrently", async () => {
    const storage = memoryStorage();
    const scopeKey = "http://127.0.0.1:43000|owner-1";
    const now = Date.now();
    const store = createPersonalCatalogCacheStore({
      ownerId: "owner-1",
      scopeKey,
      storage,
      now: () => now
    })!;
    const removed = { kind: "conversation" as const, sourceId: "source-1" };
    await store.write(sample(scopeKey, now - 1_000));
    const refreshing = sample(scopeKey, now);
    await Promise.all([
      persistPersonalCatalogSnapshot(store, refreshing),
      persistPersonalCatalogRemovals(store, scopeKey, [removed])
    ]);
    await expect(store.read()).resolves.toMatchObject({
      catalog: { items: refreshing.catalog.items },
      removals: [removed]
    });
    const restored = await store.read();
    expect(hasConversationRemoval(restored?.removals ?? [], ["source-1"])).toBe(
      true
    );
  });

  it("keeps different verified accounts in separate records", async () => {
    const storage = memoryStorage();
    const firstScope = "http://127.0.0.1:43000|owner-1";
    const secondScope = "http://127.0.0.1:43000|owner-2";
    const first = createPersonalCatalogCacheStore({
      ownerId: "owner-1",
      scopeKey: firstScope,
      storage
    })!;
    const second = createPersonalCatalogCacheStore({
      ownerId: "owner-2",
      scopeKey: secondScope,
      storage
    })!;
    await first.write(sample(firstScope, Date.now()));
    await expect(second.read()).resolves.toBeNull();
    expect(storage.values.size).toBe(1);
  });
});
