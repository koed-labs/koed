import { describe, expect, it } from "vitest";

import {
  parseMemoryScopeCommand,
  stripMemoryScopeCommands
} from "./memoryComposerCommands";

describe("memory composer scope commands", () => {
  it("parses a scope command at the start of the question", () => {
    expect(
      parseMemoryScopeCommand("/project summarize this")?.searchDomain
    ).toBe("project");
    expect(
      parseMemoryScopeCommand("/session summarize this")?.searchDomain
    ).toBe("session");
    expect(
      parseMemoryScopeCommand("/global summarize this")?.searchDomain
    ).toBe("global");
  });

  it("uses the first valid command when several commands are present", () => {
    const parsed = parseMemoryScopeCommand("compare /global and /session");

    expect(parsed).toMatchObject({
      command: "/global",
      searchDomain: "global"
    });
  });

  it("ignores command-like words that are not standalone commands", () => {
    expect(parseMemoryScopeCommand("/projector notes")).toBeNull();
    expect(parseMemoryScopeCommand("scope/global notes")).toBeNull();
  });

  it("strips recognized scope commands from the submitted query", () => {
    expect(stripMemoryScopeCommands("/project summarize this")).toBe(
      "summarize this"
    );
    expect(stripMemoryScopeCommands("compare /global and /session")).toBe(
      "compare and"
    );
  });
});
