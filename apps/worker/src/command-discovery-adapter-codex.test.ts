import { describe, expect, it } from "vitest";
import { createCodexCommandDiscoveryAdapter } from "./command-discovery-adapter-codex.js";

describe("Codex command discovery fallback", () => {
  it("does not fabricate provider commands when no selected local instance resolves", async () => {
    const adapter = createCodexCommandDiscoveryAdapter({});
    const commands = await adapter.discoverCommands({
      aiClientInstanceId: "missing.codex.instance"
    });

    expect(commands).toEqual([]);
  });
});
