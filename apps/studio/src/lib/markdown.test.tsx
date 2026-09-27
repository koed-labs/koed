import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown, sanitizeChatMarkdownUrl } from "./markdown";

function render(source: string) {
  return renderToStaticMarkup(renderMarkdown(source));
}

describe("chat markdown", () => {
  it("renders common formatting, lists, and fenced code", () => {
    const html = render(
      "**bold** and `code`\n\n- one\n- two\n\n```ts\nconst ready = true;\n```"
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<ul");
    expect(html).toContain("const ready = true;");
  });

  it("skips raw HTML and blocks images", () => {
    const html = render(
      "<script>alert(1)</script>\n\n![tracking](https://example.com/pixel.png)"
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain('aria-label="tracking"');
  });

  it("allows safe URLs and rejects dangerous protocols or credentials", () => {
    expect(sanitizeChatMarkdownUrl("https://example.com/path")).toBe(
      "https://example.com/path"
    );
    expect(sanitizeChatMarkdownUrl("javascript:alert(1)")).toBeNull();
    expect(
      sanitizeChatMarkdownUrl("https://user:secret@example.com")
    ).toBeNull();
  });
});
