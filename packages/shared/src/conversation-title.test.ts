import { expect, it } from "vitest";
import { conversationTitleFromPrompt } from "./conversation-title.js";
it("names a conversation from its first request without markup or greetings", () => {
  expect(
    conversationTitleFromPrompt(
      "Please **fix the login page**. It crashes when I sign in."
    )
  ).toBe("Fix the login page.");
  expect(conversationTitleFromPrompt("Hello world!")).toBe("Hello world!");
  expect(
    conversationTitleFromPrompt(
      "Can you explain [Markdown](https://example.com) tables?"
    )
  ).toBe("Explain Markdown tables?");
});
it("bounds long titles and handles blank and multiline prompts", () => {
  expect(
    conversationTitleFromPrompt("word ".repeat(50)).length
  ).toBeLessThanOrEqual(64);
  expect(conversationTitleFromPrompt("  Plan\nmy trip  ")).toBe("Plan my trip");
  expect(conversationTitleFromPrompt(" ")).toBe("New conversation");
});
