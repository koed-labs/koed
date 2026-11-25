import { describe, expect, it } from "vitest";
import { previewText } from "./preview-text.js";

describe("previewText", () => {
  it("drops Markdown syntax from a captured reply", () => {
    expect(
      previewText(
        "Good, that works. Check these:\n- **Title:** shows your request, not `<system-reminder>…`, and ends in an ellipsis"
      )
    ).toBe(
      "Good, that works. Check these: Title: shows your request, not <system-reminder>…, and ends in an ellipsis"
    );
  });

  it("keeps link and heading text, drops code blocks", () => {
    expect(
      previewText(
        "## Plan\n1. Read [the docs](https://example.com)\n```ts\nconst x = 1;\n```\n> _quoted_ ~~old~~"
      )
    ).toBe("Plan Read the docs quoted old");
  });

  it("leaves plain text and snake_case or math alone", () => {
    expect(previewText("pull & launch tmp/pr-554 with snake_case_name")).toBe(
      "pull & launch tmp/pr-554 with snake_case_name"
    );
    expect(previewText("2 * 3 * 4")).toBe("2 * 3 * 4");
  });
});
