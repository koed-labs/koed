import { describe, expect, it, vi } from "vitest";

import { createStudioPersonalCatalogCachePreloadApi } from "./studio-personal-catalog-cache-preload.js";
import { studioPersonalCatalogCacheCommandChannel } from "./studio-personal-catalog-cache-protocol.js";

describe("Studio Personal catalog cache preload bridge", () => {
  it("uses the scoped channel for reads and writes", async () => {
    const invoke = vi.fn(async (_channel: string, request: any) =>
      request.operation === "read"
        ? { operation: "read", value: '{"version":1}' }
        : { operation: request.operation, ok: true }
    );
    const api = createStudioPersonalCatalogCachePreloadApi(invoke);
    const identity = { ownerId: "owner-one", scopeKey: "backend|owner-one" };

    await expect(api.read(identity)).resolves.toBe('{"version":1}');
    await expect(
      api.write({ ...identity, value: '{"version":1}' })
    ).resolves.toBeUndefined();
    await expect(api.delete(identity)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      studioPersonalCatalogCacheCommandChannel,
      { operation: "read", ...identity }
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      studioPersonalCatalogCacheCommandChannel,
      { operation: "write", ...identity, value: '{"version":1}' }
    );
  });

  it("rejects an oversized cached value before IPC", async () => {
    const invoke = vi.fn();
    const api = createStudioPersonalCatalogCachePreloadApi(invoke);
    await expect(
      api.write({
        ownerId: "owner-one",
        scopeKey: "backend|owner-one",
        value: "x".repeat(1_000_001)
      })
    ).rejects.toThrow("Invalid Studio Personal catalog cache operation.");
    expect(invoke).not.toHaveBeenCalled();
  });
});
