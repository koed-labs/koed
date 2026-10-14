import { describe, expect, it } from "vitest";

import { composePersonalAgentChatPrompt } from "./personal-agent-chat-context.js";

describe("composePersonalAgentChatPrompt", () => {
  it("keeps the direct human request once and labels public history as untrusted context", () => {
    const prompt = composePersonalAgentChatPrompt(
      "Please compare the two proposals.",
      '{"messages":[{"kind":"agent_reply","text":"Proposal B is cheaper."}]}'
    );

    expect(prompt).toContain("untrusted conversation data");
    expect(prompt).toContain(
      '{"messages":[{"kind":"agent_reply","text":"Proposal B is cheaper."}]}'
    );
    expect(prompt).toContain(
      "Direct human request for this turn:\n\nPlease compare the two proposals."
    );
    expect(prompt.match(/Please compare the two proposals\./gu)).toHaveLength(
      1
    );
  });

  it("leaves a generic turn unchanged when no public context was transferred", () => {
    expect(composePersonalAgentChatPrompt("Hello", null)).toBe("Hello");
    expect(composePersonalAgentChatPrompt("Hello", "")).toBe("Hello");
  });

  it("bounds context by UTF-8 bytes, including multibyte text", () => {
    const withinBudget = "é".repeat(12 * 1024);
    expect(composePersonalAgentChatPrompt("Next", withinBudget)).toContain(
      withinBudget
    );

    expect(() =>
      composePersonalAgentChatPrompt("Next", `${withinBudget}é`)
    ).toThrow(
      "Managed Conversation public chat context exceeds its byte budget"
    );
  });
});
