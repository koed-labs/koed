import { describe, expect, it } from "vitest";
import { PersonalMemoryBoundaryError } from "./personal-memory-boundary.js";
import {
  loadNamedPersonalInventory,
  loadPersonalInventory
} from "./personal-inventory.js";

describe("Personal inventory scheduling", () => {
  it("reads named Projects without waiting for source or Folder enumeration", async () => {
    const paths: string[] = [];
    const result = await loadNamedPersonalInventory(async (path) => {
      paths.push(path);
      return { projects: [] };
    });
    expect(result.projects).toEqual([]);
    expect(paths).toEqual(["/v1/personal/projects/inventory"]);
  });

  it("reads named Projects again when they change mid-read", async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await loadNamedPersonalInventory(
      async () => {
        calls += 1;
        if (calls < 3) throw new PersonalMemoryBoundaryError("conflict", false);
        return { projects: [] };
      },
      {},
      async (ms) => {
        waits.push(ms);
      }
    );
    expect(result.projects).toEqual([]);
    expect(calls).toBe(3);
    expect(waits).toEqual([200, 400]);
  });

  it("reports a failed load, not a conflict, when Projects keep changing", async () => {
    await expect(
      loadNamedPersonalInventory(
        async () => {
          throw new PersonalMemoryBoundaryError("conflict", false);
        },
        {},
        async () => undefined
      )
    ).rejects.toMatchObject({ code: "request_failed", retryable: true });
  });

  it("starts independent inventories together and preserves complete source pagination", async () => {
    let finishFirst!: (page: Record<string, unknown>) => void;
    const first = new Promise<Record<string, unknown>>((resolve) => {
      finishFirst = resolve;
    });
    const paths: string[] = [];
    const cursor = JSON.stringify({
      ownerUserId: "00000000-0000-4000-8000-000000000001",
      after: { projectId: "source", threadId: "thread", sessionId: "" }
    });
    const result = loadPersonalInventory((path) => {
      paths.push(path);
      if (path === "/v1/personal/sources/inventory") return first;
      return Promise.resolve(
        path.startsWith("/v1/personal/sources/inventory?")
          ? { gitSources: [], unresolved: [], nextCursor: null }
          : { projects: [] }
      );
    });
    expect(paths).toEqual([
      "/v1/personal/sources/inventory",
      "/v1/personal/projects/inventory",
      "/v1/personal/folders/inventory"
    ]);
    finishFirst({ gitSources: [], unresolved: [], nextCursor: cursor });
    await expect(result).resolves.toEqual({ projects: [] });
    expect(paths[3]).toBe(
      `/v1/personal/sources/inventory?${new URLSearchParams({ cursor })}`
    );
  });
});
