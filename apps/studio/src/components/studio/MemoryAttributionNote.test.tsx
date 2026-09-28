import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryAttributionNote } from "./MemoryAttributionNote";

describe("MemoryAttributionNote", () => {
  it("renders authorized source labels as plain text without controls or links", () => {
    const html = renderToStaticMarkup(
      <MemoryAttributionNote
        memory={{
          used: true,
          status: "available",
          citations: [{ label: "<Source & notes>" }]
        }}
      />
    );

    expect(html).toContain("mt-2 rounded-md border border-accent/25");
    expect(html).toContain("&lt;Source &amp; notes&gt;");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("button");
    expect(html).not.toContain("Thumbs");
  });

  it("labels used memory without resolved citations", () => {
    const html = renderToStaticMarkup(
      <MemoryAttributionNote
        memory={{ used: true, status: "available", citations: [] }}
      />
    );
    expect(html).toContain("From Memory");
  });

  it("shows an unavailable notice even when memory was not used", () => {
    const html = renderToStaticMarkup(
      <MemoryAttributionNote
        memory={{ used: false, status: "unavailable", citations: [] }}
      />
    );
    expect(html).toContain("Memory could not be checked");
    expect(html).not.toContain("From Memory");
  });

  it("renders nothing for an available response that did not use memory", () => {
    expect(
      renderToStaticMarkup(
        <MemoryAttributionNote
          memory={{ used: false, status: "available", citations: [] }}
        />
      )
    ).toBe("");
  });
});
