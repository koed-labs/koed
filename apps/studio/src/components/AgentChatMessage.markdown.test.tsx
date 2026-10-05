import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentChatMessage } from "./SharedChatUI";

const source = [
  "# Markdown reply",
  "",
  "**Bold** and *italic*, ~~removed~~ and `inlineCode`.",
  "",
  "- First item",
  "- Second item",
  "",
  "1. Ordered item",
  "",
  "- [x] Done",
  "",
  "> Quoted text",
  "",
  "```ts",
  "const value = 42;",
  "```",
  "",
  "```",
  "unlabelled code",
  "```",
  "",
  "| Name | Status |",
  "| --- | --- |",
  "| Koed | Ready |",
  "",
  "[Read more](https://example.com/docs)"
].join("\n");

describe("AI reply Markdown", () => {
  it.each([false, true])(
    "renders Markdown in shared AI messages (compact=%s)",
    (compact) => {
      const html = renderToStaticMarkup(
        <AgentChatMessage
          compact={compact}
          message={{ id: "reply", role: "assistant", content: source }}
        >
          <span>Message action</span>
        </AgentChatMessage>
      );
      expect(html).toContain("<h3");
      expect(html).toContain("<strong>Bold</strong>");
      expect(html).toContain("<em>italic</em>");
      expect(html).toContain("<del>removed</del>");
      expect(html).toContain("<ul");
      expect(html).toContain("<ol");
      expect(html).toContain('type="checkbox"');
      expect(html).toContain("<blockquote");
      expect(html.match(/<pre\b/g)).toHaveLength(2);
      expect(html).toContain("const value = 42;");
      expect(html).toContain("<table");
      expect(html).toContain('href="https://example.com/docs"');
      expect(html).toContain("Message action");
      expect(html).not.toContain("**Bold**");
    }
  );

  it("preserves Markdown markers literally in the user's question", () => {
    const html = renderToStaticMarkup(
      <AgentChatMessage
        message={{ id: "question", role: "user", content: source }}
      />
    );
    expect(html).toContain("**Bold**");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<strong");
  });

  it("retains existing link and HTML protections in AI replies", () => {
    const html = renderToStaticMarkup(
      <AgentChatMessage
        message={{
          id: "reply",
          role: "assistant",
          content:
            "<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n![image](https://example.com/pixel.png)"
        }}
      />
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<img");
  });
});
