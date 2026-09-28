import { describe, expect, it } from "vitest";

import {
  findActiveSlashCommand,
  filterSlashCommands,
  applySlashCommandReplacement,
  slashCommandKeypressIsHandled
} from "./ai-client-slash-suggestions.js";

import type { ManagedConversationSlashCommand } from "./ai-client-slash-suggestions.js";

const EXAMPLE_COMMANDS: ManagedConversationSlashCommand[] = [
  { name: "query", description: "Search across memory", kind: "command", source: "provider" },
  { name: "edit", description: "Edit the conversation", kind: "command", source: "provider" },
  { name: "draft", description: "Draft a message", kind: "command", source: "provider", argumentHint: "<text>" },
  { name: "refine", description: "Refine a result", kind: "skill", source: "provider" }
];

describe("findActiveSlashCommand", () => {
  it("finds slash at input start", () => {
    // text="/q", cursorIndex=2, slash at 0, query-only range=[1,2), query="q"
    expect(findActiveSlashCommand({ text: "/q", cursorIndex: 2 })).toEqual({
      query: "q",
      range: { start: 1, end: 2 }
    });
  });

  it("ignores slash not at start or after whitespace", () => {
    expect(findActiveSlashCommand({ text: "abc/def", cursorIndex: 6 })).toBeNull();
  });

  it("finds inline slash after whitespace", () => {
    // "hello /edit", cursor=11 (end), slash at 6, query-only range=[7,11), query="edit"
    expect(findActiveSlashCommand({ text: "hello /edit", cursorIndex: 11 })).toEqual({
      query: "edit",
      range: { start: 7, end: 11 }
    });
  });

  it("handles cursor in middle of query", () => {
    // "/que", cursor=3, slash at 0, query-only range=[1,3), query="qu"
    expect(findActiveSlashCommand({ text: "/que", cursorIndex: 3 })).toEqual({
      query: "qu",
      range: { start: 1, end: 3 }
    });
  });

  it("returns null for empty text", () => {
    expect(findActiveSlashCommand({ text: "", cursorIndex: 0 })).toBeNull();
  });

  it("finds slash at end with no query", () => {
    // "/", cursor=1, slash at 0, query-only range=[1,1), query=""
    expect(findActiveSlashCommand({ text: "/", cursorIndex: 1 })).toEqual({
      query: "",
      range: { start: 1, end: 1 }
    });
  });

  it("finds slash after newline", () => {
    // "line1\n/next", cursor=11 (end), slash at 6, query-only range=[7,11), query="next"
    expect(findActiveSlashCommand({ text: "line1\n/next", cursorIndex: 11 })).toEqual({
      query: "next",
      range: { start: 7, end: 11 }
    });
  });

  it("finds slash after tab", () => {
    // "cmd\t/next", cursor=9, slash at 4, query-only range=[5,9), query="next"
    expect(findActiveSlashCommand({ text: "cmd\t/next", cursorIndex: 9 })).toEqual({
      query: "next",
      range: { start: 5, end: 9 }
    });
  });

  it("returns null for slash after quote", () => {
    // "/wo'rld", cursor=7, backward scan finds quote at 3 before slash at 0
    expect(findActiveSlashCommand({ text: "/wo'rld", cursorIndex: 7 })).toBeNull();
  });

  it("returns empty query when cursor at slash", () => {
    // "/command", cursor=1, slash at 0, query-only range=[1,1), query=""
    expect(findActiveSlashCommand({ text: "/command", cursorIndex: 1 })).toEqual({
      query: "",
      range: { start: 1, end: 1 }
    });
  });

  it("finds inner slash when multiple slashes exist", () => {
    // "/a /b", cursor=5, backward scan finds / at 3, query-only range=[4,5)
    expect(findActiveSlashCommand({ text: "/a /b", cursorIndex: 5 })).toEqual({
      query: "b",
      range: { start: 4, end: 5 }
    });
  });
});

describe("filterSlashCommands", () => {
  it("returns all commands for empty query", () => {
    const result = filterSlashCommands(EXAMPLE_COMMANDS, "");
    expect(result).toEqual(EXAMPLE_COMMANDS);
  });

  it("filters by command name", () => {
    const result = filterSlashCommands(EXAMPLE_COMMANDS, "q");
    expect(result).toEqual([EXAMPLE_COMMANDS[0]]);
  });

  it("filters case-insensitively", () => {
    const result = filterSlashCommands(EXAMPLE_COMMANDS, "QUE");
    expect(result).toEqual([EXAMPLE_COMMANDS[0]]);
  });

  it("filters by description", () => {
    const result = filterSlashCommands(EXAMPLE_COMMANDS, "edit");
    expect(result).toEqual([EXAMPLE_COMMANDS[1]]);
  });

  it("returns empty array when no match", () => {
    const result = filterSlashCommands(EXAMPLE_COMMANDS, "xyz");
    expect(result).toEqual([]);
  });

  it("preserves original order for multiple matches", () => {
    const result = filterSlashCommands(EXAMPLE_COMMANDS, "m");
    // "message" in draft description, "memory" in query description
    expect(result).toEqual([EXAMPLE_COMMANDS[0], EXAMPLE_COMMANDS[2]]);
  });

  it("handles duplicate names — keeps all", () => {
    const dupes = [
      ...EXAMPLE_COMMANDS,
      { name: "edit", description: "Duplicate edit", kind: "command", source: "provider" }
    ];
    const result = filterSlashCommands(dupes, "edit");
    expect(result).toHaveLength(2);
  });
});

describe("applySlashCommandReplacement", () => {
  it("replaces slash command at start", () => {
    // range=[1,2), text="/q" → "/query "
    expect(
      applySlashCommandReplacement({ text: "/q", range: { start: 1, end: 2 }, commandName: "query" })
    ).toBe("/query ");
  });

  it("replaces inline slash command", () => {
    // range=[7,11), text="hello /edit" → "hello /draft "
    expect(
      applySlashCommandReplacement({ text: "hello /edit", range: { start: 7, end: 11 }, commandName: "draft" })
    ).toBe("hello /draft ");
  });

  it("replaces and keeps trailing text when text follows cursor", () => {
    // range=[1,5), text="/edit next" → "/query next"
    expect(
      applySlashCommandReplacement({ text: "/edit next", range: { start: 1, end: 5 }, commandName: "query" })
    ).toBe("/query next");
  });

  it("adds trailing space only when replacement reaches end of input", () => {
    // range=[1,4), text="/abc" → "/x "
    expect(
      applySlashCommandReplacement({ text: "/abc", range: { start: 1, end: 4 }, commandName: "x" })
    ).toBe("/x ");
  });

  it("does not add trailing space when text follows cursor", () => {
    // range=[1,3), text="/ab postfix" → "/x postfix"
    expect(
      applySlashCommandReplacement({ text: "/ab postfix", range: { start: 1, end: 3 }, commandName: "x" })
    ).toBe("/x postfix");
  });

  it("replaces with empty command name", () => {
    // range=[1,1), text="/" → "/ "
    expect(
      applySlashCommandReplacement({ text: "/", range: { start: 1, end: 1 }, commandName: "" })
    ).toBe("/ ");
  });
});

describe("slashCommandKeypressIsHandled", () => {
  it("returns true for ArrowDown when menu open", () => {
    expect(slashCommandKeypressIsHandled({ key: "ArrowDown", open: true, isComposing: false })).toBe(true);
  });

  it("returns true for ArrowUp when menu open", () => {
    expect(slashCommandKeypressIsHandled({ key: "ArrowUp", open: true, isComposing: false })).toBe(true);
  });

  it("returns true for Tab when menu open", () => {
    expect(slashCommandKeypressIsHandled({ key: "Tab", open: true, isComposing: false })).toBe(true);
  });

  it("returns true for Escape when menu open", () => {
    expect(slashCommandKeypressIsHandled({ key: "Escape", open: true, isComposing: false })).toBe(true);
  });

  it("returns true for Enter when menu open and no IME", () => {
    expect(slashCommandKeypressIsHandled({ key: "Enter", open: true, isComposing: false })).toBe(true);
  });

  it("returns false for Enter when menu open with IME composing", () => {
    expect(slashCommandKeypressIsHandled({ key: "Enter", open: true, isComposing: true })).toBe(false);
  });

  it("returns false for Enter when menu closed", () => {
    expect(slashCommandKeypressIsHandled({ key: "Enter", open: false, isComposing: false })).toBe(false);
  });

  it("returns false for keys not handled by autocomplete", () => {
    expect(slashCommandKeypressIsHandled({ key: "a", open: true, isComposing: false })).toBe(false);
  });

  it("returns false when disabled", () => {
    expect(slashCommandKeypressIsHandled({ key: "Enter", open: true, isComposing: false, disabled: true })).toBe(false);
  });
});
