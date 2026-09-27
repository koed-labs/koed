import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRMarkdown, sanitizePrMarkdownUrl } from "./PRMarkdown";

function render(source: string) {
  return renderToStaticMarkup(<PRMarkdown source={source} />);
}

describe("PRMarkdown", () => {
  it("renders GFM headings, lists, tasks, code, and tables", () => {
    const html = render(
      [
        "# Summary",
        "",
        "- one",
        "- two",
        "",
        "- [x] checked",
        "",
        "```ts",
        "const safe = true;",
        "```",
        "",
        "| Name | State |",
        "| --- | --- |",
        "| Koed | ready |"
      ].join("\n")
    );

    expect(html).toContain("Summary");
    expect(html).toContain("const safe = true;");
    expect(html).toContain("<table");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("disabled");
  });

  it("skips raw HTML and never emits remote images", () => {
    const html = render(
      '<script>globalThis.pwned = true</script>\n\n![tracking](https://example.com/pixel.png)'
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain('role="img"');
    expect(html).toContain("tracking");
  });

  it("rejects unsafe links and keeps safe links external", () => {
    const html = render(
      "[safe](https://github.com/koed/studio/pull/42) [bad](javascript:alert(1))"
    );

    expect(html).toContain('href="https://github.com/koed/studio/pull/42"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(sanitizePrMarkdownUrl("data:text/html,pwned")).toBeNull();
    expect(sanitizePrMarkdownUrl("https://user:secret@example.com")).toBeNull();
  });
});
