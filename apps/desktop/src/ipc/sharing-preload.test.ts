import { describe, expect, it, vi } from "vitest";
import { createSharingPreloadApi } from "./sharing-preload.js";
import { sharingChannel } from "./sharing-protocol.js";

describe("Sharing preload", () => {
  it("sends only a read command and accepts explicit backend availability", async () => {
    const invoke = vi.fn(async () => ({
      backends: [
        {
          backendId: "team-down",
          status: "unavailable",
          lastReachedAt: null,
          reason: "unreachable"
        }
      ]
    }));
    expect(
      (await createSharingPreloadApi(invoke).read()).backends[0]?.status
    ).toBe("unavailable");
    expect(invoke).toHaveBeenCalledWith(sharingChannel, { operation: "read" });
  });
  it("rejects unrecognized upstream fields", async () => {
    const api = createSharingPreloadApi(async () => ({
      backends: [],
      upstreamCredential: "secret"
    }));
    await expect(api.read()).rejects.toThrow();
  });
});
