import { describe, expect, it } from "vitest";
import { resolveMcpConversationDirectory } from "../src/conversation-directory.js";

describe("MCP Conversation directory selection", () => {
  const base = { startupCwd: "/unrelated/process" };
  const metadata = {
    "x-codex-turn-metadata": { workspaces: { "/repo/source": {} } }
  };
  it("prefers a native hook observation, then the private managed Conversation, then one Codex workspace", () => {
    expect(
      resolveMcpConversationDirectory({
        ...base,
        metadata,
        conversationCwd: "/repo/hook",
        managedCwd: "/repo/managed"
      })
    ).toBe("/repo/hook");
    expect(
      resolveMcpConversationDirectory({
        ...base,
        metadata,
        managedCwd: "/repo/managed"
      })
    ).toBe("/repo/managed");
    expect(resolveMcpConversationDirectory({ ...base, metadata })).toBe(
      "/repo/source"
    );
  });
  it.each([
    undefined,
    {},
    { workspaces: {} },
    { workspaces: { relative: {} } },
    { workspaces: { "/repo/a": {}, "/repo/b": {} } }
  ])(
    "does not guess a Codex Project from missing or ambiguous context: %j",
    (turn) => {
      expect(
        resolveMcpConversationDirectory({
          ...base,
          clientName: "codex-mcp-client",
          metadata: { "x-codex-turn-metadata": turn }
        })
      ).toBeUndefined();
    }
  );
  it("rejects invalid managed context rather than falling back to another folder", () => {
    expect(() =>
      resolveMcpConversationDirectory({
        ...base,
        metadata,
        managedCwd: "relative"
      })
    ).toThrow("absolute Conversation directory");
    expect(resolveMcpConversationDirectory(base)).toBe(base.startupCwd);
  });
});
