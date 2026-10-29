import { describe, expect, it } from "vitest";
import { conversationToolKindAndLabel } from "./personal-desktop-contract.js";

describe("conversation tool labels", () => {
  it("names Koed memory tools in plain words whatever the client prefix", () => {
    for (const name of [
      "koed.memory_answer",
      "mcp__koed__memory_answer_result",
      "memory_search"
    ])
      expect(conversationToolKindAndLabel(name)).toEqual({
        kind: "search",
        label: "Checked memory"
      });
    expect(
      conversationToolKindAndLabel("koed.memory_intake_propose").label
    ).toBe("Suggested a memory");
  });
});
