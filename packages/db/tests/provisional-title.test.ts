import { describe, expect, it } from "vitest";
import { deriveProvisionalSessionTitle } from "../src/repository.js";

describe("provisional Conversation titles", () => {
  it("keeps the User's words after a long injected context block", () => {
    const reminder = `<system-reminder>${"You are operating in a git worktree. ".repeat(14)}</system-reminder>`;
    expect(reminder.length).toBeGreaterThan(495);
    expect(
      deriveProvisionalSessionTitle(
        "user",
        `${reminder}\nReview the onboarding flow`,
        undefined
      )
    ).toBe("Review the onboarding flow");
  });

  it("finds the Codex request after an injected block and an attachment list", () => {
    expect(
      deriveProvisionalSessionTitle(
        "user",
        [
          "<system-reminder>Context for the agent.</system-reminder>",
          "# Files mentioned by the user:",
          "",
          "## CleanShot 2026-11-25 at 09.00.00.png: /tmp/CleanShot.png",
          "",
          "## My request for Codex:",
          "Review the onboarding flow"
        ].join("\n"),
        undefined
      )
    ).toBe("Review the onboarding flow");
  });

  it("has no title when the message is only injected context", () => {
    expect(
      deriveProvisionalSessionTitle(
        "user",
        '<paseo-system version="1">context only</paseo-system>',
        undefined
      )
    ).toBeNull();
  });
});
