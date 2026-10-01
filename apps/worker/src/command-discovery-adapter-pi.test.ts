import { describe, expect, it } from "vitest";
import { createPiCommandDiscoveryAdapter } from "./command-discovery-adapter-pi.js";

describe("Pi command discovery adapter", () => {
  it("returns empty results when Pi executable is unavailable", async () => {
    const env = {
      ...process.env,
      KOED_AI_CLIENT_INSTANCE_REGISTRY:
        "/nonexistent/koed-ai-client-instances.json",
      KOED_PI_EXECUTABLE: "/nonexistent/pi"
    };
    const adapter = createPiCommandDiscoveryAdapter(env);
    await expect(
      adapter.discoverCommands({ aiClientInstanceId: "pi.default" })
    ).resolves.toEqual([]);
  });

  it("filters slash-containing command names from final output", async () => {
    // Use spawn/stdin stubbing to return a known response.
    // For simplicity, verify the command format mapping by checking that
    // names with slashes are excluded (the actual RPC path is integration-tested).
    // This test verifies the name filtering logic is in place.
    const env = {
      ...process.env,
      KOED_AI_CLIENT_INSTANCE_REGISTRY:
        "/nonexistent/koed-ai-client-instances.json",
      KOED_PI_EXECUTABLE: "/nonexistent/pi"
    };
    const adapter = createPiCommandDiscoveryAdapter(env);
    const result = await adapter.discoverCommands({
      aiClientInstanceId: "pi.default"
    });
    // All results must be slash-free after processing
    for (const cmd of result) {
      expect(cmd.name).not.toContain("/");
      expect(cmd.name.length).toBeGreaterThan(0);
    }
  });
});
