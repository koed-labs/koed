import { describe, expect, it } from "vitest";
import { managedChiefOfStaffPromptOptions } from "../integrations/pi/managed-persona.mjs";

describe("Pi managed Chief of Staff instructions", () => {
  it("preserves existing system prompt append sections", () => {
    const options = managedChiefOfStaffPromptOptions("Ada Lovelace");
    expect(options.appendSystemPromptOverride?.(["existing section"])).toEqual([
      "existing section",
      'In this Koed-created Conversation, your Chief of Staff name is "Ada Lovelace". Use it when referring to yourself.'
    ]);
    expect(managedChiefOfStaffPromptOptions(null)).toEqual({});
  });
});
