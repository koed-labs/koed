import { describe, expect, it } from "vitest";
import { codexItemActivity } from "../src/codex-managed-conversation.js";

describe("Codex item activity", () => {
  it("describes started items in plain words", () => {
    expect(
      codexItemActivity({
        type: "mcpToolCall",
        server: "koed",
        tool: "memory_answer"
      })
    ).toBe("Checking memory");
    expect(
      codexItemActivity({ type: "mcpToolCall", server: "x", tool: "get_page" })
    ).toBe("Using get page");
    expect(codexItemActivity({ type: "commandExecution" })).toBe(
      "Running a command"
    );
    expect(codexItemActivity({ type: "reasoning" })).toBe("Thinking");
    expect(codexItemActivity({ type: "userMessage" })).toBeNull();
  });
});
