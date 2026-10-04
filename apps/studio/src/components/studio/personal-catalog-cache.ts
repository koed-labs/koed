import type { PersonalRemovalTarget } from "@/lib/personal-removals-client";

export type PersonalCatalogCacheSnapshot = Readonly<{
  schemaVersion: 1;
  scopeKey: string;
  cachedAt: number;
  provider: "all" | "codex" | "claude-code" | "pi";
  catalog: Readonly<{
    items: readonly unknown[];
    providers: Readonly<Record<string, unknown>>;
    truncated: boolean;
  }>;
  projects: readonly unknown[];
  removals: readonly PersonalRemovalTarget[];
}>;

export type PersonalCatalogCacheStore = Readonly<{
  read: () => Promise<PersonalCatalogCacheSnapshot | null>;
  write: (snapshot: PersonalCatalogCacheSnapshot) => Promise<void>;
  clear: () => Promise<void>;
}>;

const CACHE_PREFIX = "koed:studio:personal-catalog:v1:";
const MAX_CACHE_BYTES = 1_000_000;
export const PERSONAL_CATALOG_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const updateQueues = new Map<string, Promise<void>>();

type DesktopCacheBridge = {
  read(input: { ownerId: string; scopeKey: string }): Promise<string | null>;
  write(input: {
    ownerId: string;
    scopeKey: string;
    value: string;
  }): Promise<void>;
  delete(input: { ownerId: string; scopeKey: string }): Promise<void>;
};

function desktopBridge(): DesktopCacheBridge | null {
  if (typeof window === "undefined") return null;
  return (
    (
      window as unknown as {
        koedStudioPersonalCatalogCache?: DesktopCacheBridge;
      }
    ).koedStudioPersonalCatalogCache ?? null
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validRemoval(value: unknown): value is PersonalRemovalTarget {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    (item.kind === "project" && typeof item.projectId === "string") ||
    (item.kind === "conversation" && typeof item.sourceId === "string")
  );
}

function parseCache(
  value: unknown,
  scopeKey: string,
  now: number
): PersonalCatalogCacheSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.scopeKey !== scopeKey ||
    !["all", "codex", "claude-code", "pi"].includes(
      String(candidate.provider)
    ) ||
    typeof candidate.cachedAt !== "number" ||
    !Number.isFinite(candidate.cachedAt) ||
    candidate.cachedAt > now + 60_000 ||
    now - candidate.cachedAt > PERSONAL_CATALOG_CACHE_MAX_AGE_MS ||
    !candidate.catalog ||
    typeof candidate.catalog !== "object" ||
    Array.isArray(candidate.catalog) ||
    !Array.isArray(candidate.projects) ||
    !Array.isArray(candidate.removals)
  ) {
    return null;
  }
  const catalog = candidate.catalog as Record<string, unknown>;
  if (
    !Array.isArray(catalog.items) ||
    !catalog.providers ||
    typeof catalog.providers !== "object" ||
    Array.isArray(catalog.providers) ||
    typeof catalog.truncated !== "boolean" ||
    !candidate.removals.every(validRemoval)
  ) {
    return null;
  }
  return candidate as unknown as PersonalCatalogCacheSnapshot;
}

export function createPersonalCatalogCacheStore(input: {
  ownerId: string;
  scopeKey: string;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  now?: () => number;
}): PersonalCatalogCacheStore | null {
  const ownerId = input.ownerId.trim();
  const scopeKey = input.scopeKey.trim();
  if (!ownerId || !scopeKey || scopeKey.split("|").at(-1) !== ownerId)
    return null;
  const key = `${CACHE_PREFIX}${encodeURIComponent(scopeKey)}`;
  const bridge = desktopBridge();
  let storage = input.storage;
  if (!bridge && !storage && typeof window !== "undefined") {
    try {
      storage = window.localStorage;
    } catch {
      storage = undefined;
    }
  }
  const readRaw = async () => {
    try {
      return bridge
        ? await bridge.read({ ownerId, scopeKey })
        : (storage?.getItem(key) ?? null);
    } catch {
      return null;
    }
  };
  const writeRaw = async (value: string) => {
    try {
      if (bridge) await bridge.write({ ownerId, scopeKey, value });
      else storage?.setItem(key, value);
    } catch {
      // Cache failures must not prevent the live catalog from loading.
    }
  };
  const clearRaw = async () => {
    try {
      if (bridge) await bridge.delete({ ownerId, scopeKey });
      else storage?.removeItem(key);
    } catch {
      // A stale cache will be rejected by scope and age checks on read.
    }
  };
  return {
    read: async () => {
      const raw = await readRaw();
      if (!raw || byteLength(raw) > MAX_CACHE_BYTES) return null;
      try {
        return parseCache(JSON.parse(raw), scopeKey, (input.now ?? Date.now)());
      } catch {
        return null;
      }
    },
    write: async (snapshot) => {
      if (
        snapshot.schemaVersion !== 1 ||
        snapshot.scopeKey !== scopeKey ||
        byteLength(JSON.stringify(snapshot)) > MAX_CACHE_BYTES
      )
        return;
      await writeRaw(JSON.stringify(snapshot));
    },
    clear: clearRaw
  };
}

export function personalCatalogOwnerId(scopeKey: string | null): string | null {
  if (!scopeKey) return null;
  const separator = scopeKey.lastIndexOf("|");
  if (separator <= 0) return null;
  const ownerId = scopeKey.slice(separator + 1).trim();
  return ownerId ? ownerId : null;
}

export async function persistPersonalCatalogRemovals(
  store: PersonalCatalogCacheStore,
  scopeKey: string,
  removals: readonly PersonalRemovalTarget[]
): Promise<void> {
  await serializeCacheUpdate(scopeKey, async () => {
    const existing = await store.read();
    await store.write({
      schemaVersion: 1,
      scopeKey,
      cachedAt: existing?.cachedAt ?? Date.now(),
      provider: existing?.provider ?? "all",
      catalog: existing?.catalog ?? {
        items: [],
        providers: {},
        truncated: false
      },
      projects: existing?.projects ?? [],
      removals
    });
  });
}

export async function persistPersonalCatalogSnapshot(
  store: PersonalCatalogCacheStore,
  snapshot: PersonalCatalogCacheSnapshot
): Promise<void> {
  await serializeCacheUpdate(snapshot.scopeKey, async () => {
    const existing = await store.read();
    await store.write({
      ...snapshot,
      removals: existing?.removals ?? snapshot.removals
    });
  });
}

function serializeCacheUpdate(
  scopeKey: string,
  update: () => Promise<void>
): Promise<void> {
  const previous = updateQueues.get(scopeKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(update);
  updateQueues.set(scopeKey, next);
  void next.finally(() => {
    if (updateQueues.get(scopeKey) === next) updateQueues.delete(scopeKey);
  });
  return next;
}
