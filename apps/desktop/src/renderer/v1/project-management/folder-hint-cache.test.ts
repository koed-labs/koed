import { describe, expect, it, vi } from "vitest";
import type { PersonalFolderHint } from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import { createFolderHintCache, loadFolderHints } from "./folder-hint-cache.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const none = (n: number): PersonalFolderHint => ({
  sessionId: id(n),
  tier: "none",
  score: 0,
  reasons: []
});
const api = (folderHints: PersonalDesktopApi["folderHints"]) =>
  ({ folderHints }) as PersonalDesktopApi;

describe("createFolderHintCache", () => {
  it("expires entries after the time to live", () => {
    let now = 0;
    const cache = createFolderHintCache(1000, () => now);
    cache.set("a", [none(1)]);
    now = 999;
    expect(cache.get("a")).toEqual([none(1)]);
    now = 1001;
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("loadFolderHints", () => {
  it("asks in batches of 50, asks once per id, and reports each batch", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => id(i + 1));
    const folderHints = vi.fn(
      async ({ sessionIds }: { sessionIds: string[] }) =>
        sessionIds.map((sessionId) => ({ ...none(0), sessionId }))
    );
    const onBatch = vi.fn();
    const cache = createFolderHintCache();
    await loadFolderHints(api(folderHints), [...ids, ids[0]!], {
      cache,
      onBatch
    });
    expect(
      folderHints.mock.calls.map(([input]) => input.sessionIds.length)
    ).toEqual([50, 50, 20]);
    expect(onBatch).toHaveBeenCalledTimes(3);
    // A second load is served from the cache.
    await loadFolderHints(api(folderHints), ids, { cache });
    expect(folderHints).toHaveBeenCalledTimes(3);
  });

  it("skips a failed batch, remembers ids with no hint, and stops when cancelled", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => id(i + 1));
    const folderHints = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([none(51)]);
    const cache = createFolderHintCache();
    const result = await loadFolderHints(api(folderHints), ids, { cache });
    expect(result.has(id(1))).toBe(false);
    expect(result.get(id(51))).toEqual([none(51)]);
    expect(result.get(id(52))).toEqual([]);
    const cancelled = vi.fn();
    await loadFolderHints(api(cancelled), [id(99)], {
      cache: createFolderHintCache(),
      isCancelled: () => true
    });
    expect(cancelled).not.toHaveBeenCalled();
  });
});
