import { describe, expect, it } from "vitest";
import { formatComposerText } from "./chatFormatting";

describe("formatComposerText", () => {
  it("wraps a selected range and keeps the selection inside the markers", () => {
    expect(formatComposerText("hello world", 6, 11, "bold")).toEqual({
      text: "hello **world**",
      start: 8,
      end: 13
    });
  });

  it("places the caret between inline markers when the selection is empty", () => {
    expect(formatComposerText("hello", 2, 2, "inline-code")).toEqual({
      text: "he``llo",
      start: 3,
      end: 3
    });
  });

  it("prefixes every selected line and preserves the selection", () => {
    expect(
      formatComposerText("one\ntwo\nthree", 0, 7, "numbered-list")
    ).toEqual({
      text: "1. one\n2. two\nthree",
      start: 3,
      end: 13
    });
  });

  it("creates a fenced block around the selection and keeps its contents selected", () => {
    expect(
      formatComposerText("before code after", 7, 11, "code-block")
    ).toEqual({
      text: "before \n```\ncode\n```\n after",
      start: 12,
      end: 16
    });
  });
});
