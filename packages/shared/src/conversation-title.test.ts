import { describe, expect, it } from "vitest";
import {
  displayConversationTitle,
  stripHarnessBlocks,
  stripHarnessMarkup
} from "./conversation-title.js";

describe("conversation titles", () => {
  it("removes closed harness blocks and keeps the User's words", () => {
    expect(
      stripHarnessMarkup(
        "<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>\npull & launch the branch"
      )
    ).toBe("pull & launch the branch");
    expect(
      stripHarnessMarkup(
        '<paseo-system version="1" kind="context">ctx</paseo-system> Review PR 552'
      )
    ).toBe("Review PR 552");
  });

  it("drops a harness block that was truncated before its closing tag", () => {
    expect(
      displayConversationTitle(
        "<system-reminder> You are operating in a git wor"
      )
    ).toBeNull();
    expect(displayConversationTitle('<paseo-system version="1" ki')).toBeNull();
  });

  it("can keep line breaks for parsers that need the text's structure", () => {
    expect(
      stripHarnessBlocks(
        "<system-reminder>ctx</system-reminder>\n## My request for Codex:\nShip it"
      )
    ).toBe("## My request for Codex:\nShip it");
  });

  it("keeps ordinary titles and other angle-bracket text", () => {
    expect(displayConversationTitle("Fix <Button> focus ring")).toBe(
      "Fix <Button> focus ring"
    );
    expect(displayConversationTitle("")).toBeNull();
    expect(displayConversationTitle(null)).toBeNull();
  });
});
