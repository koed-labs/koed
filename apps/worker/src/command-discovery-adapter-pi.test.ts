import { describe, expect, it, vi } from "vitest";
import { createPiCommandDiscoveryAdapter } from "./command-discovery-adapter-pi.js";

const { mockDiscover } = vi.hoisted(() => ({ mockDiscover: vi.fn() }));
vi.mock("./command-discovery-adapter.js", () => ({
  createCommandDiscoveryAdapter: vi.fn(() => ({
    discoverCommands: mockDiscover
  }))
}));

describe("Pi command discovery adapter", () => {
  it("returns unverified file commands with slash-free names", async () => {
    mockDiscover.mockResolvedValueOnce([
      {
        name: "/review",
        description: "Review changes",
        kind: "command",
        source: "global-file",
        scope: "global",
        verification: "verified"
      },
      {
        name: "nested/skill",
        description: "Nested skill",
        kind: "skill",
        source: "project-file",
        scope: "project"
      }
    ]);
    const adapter = createPiCommandDiscoveryAdapter();

    await expect(
      adapter.discoverCommands({ aiClientInstanceId: "pi.default" })
    ).resolves.toEqual([
      {
        name: "review",
        description: "Review changes",
        kind: "command",
        source: "global-file",
        scope: "global",
        verification: "unverified"
      }
    ]);
    expect(mockDiscover).toHaveBeenCalledWith({
      aiClientInstanceId: "pi.default"
    });
  });

  it("returns empty results without commands", async () => {
    mockDiscover.mockResolvedValueOnce([]);
    const adapter = createPiCommandDiscoveryAdapter();
    await expect(
      adapter.discoverCommands({ aiClientInstanceId: "pi.default" })
    ).resolves.toEqual([]);
  });
});
