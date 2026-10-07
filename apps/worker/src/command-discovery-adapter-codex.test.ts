import { beforeEach, describe, expect, it, vi } from "vitest";
import { listCodexAppServerSkills } from "@koed/mcp-server";
import {
  createCodexCommandDiscoveryAdapter,
  listCodexDraftCommands
} from "./command-discovery-adapter-codex.js";

vi.mock("@koed/mcp-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@koed/mcp-server")>()),
  listCodexAppServerSkills: vi.fn()
}));

beforeEach(() => vi.clearAllMocks());

describe("Codex command discovery fallback", () => {
  it("does not fabricate provider commands when no selected local instance resolves", async () => {
    const adapter = createCodexCommandDiscoveryAdapter({});
    await expect(
      adapter.discoverCommands({ aiClientInstanceId: "missing.codex.instance" })
    ).resolves.toEqual([]);
  });

  it("reads enabled skills from the actual nested skills/list response", async () => {
    vi.mocked(listCodexAppServerSkills).mockResolvedValue({
      data: [
        {
          cwd: "/temporary-draft",
          skills: [
            {
              name: "review",
              description: "Review changes",
              scope: "user",
              enabled: true
            },
            { name: "disabled", scope: "user", enabled: false },
            { name: "project-only", scope: "repo", enabled: true },
            { name: "../invalid", scope: "user", enabled: true }
          ],
          errors: []
        }
      ]
    });
    const commands = await listCodexDraftCommands({
      aiClientInstanceId: "codex.default",
      environment: { CODEX_HOME: "/nonexistent-koed-test-home" }
    });
    expect(commands).toEqual([
      {
        name: "review",
        description: "Review changes",
        kind: "skill",
        source: "provider",
        verification: "verified",
        scope: "global"
      }
    ]);
    expect(listCodexAppServerSkills).toHaveBeenCalledOnce();
  });
});
