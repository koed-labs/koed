// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SecureMarkdown,
  sanitizeMarkdownUrl,
  validateMarkdownInput,
  type MarkdownPlatformAdapters
} from "./SecureMarkdown.js";

describe("SecureMarkdown URL policy", () => {
  it.each([
    ["https://example.com/path?q=1", "https://example.com/path?q=1"],
    ["http://example.com", "http://example.com/"],
    ["mailto:user@example.com", "mailto:user@example.com"]
  ])("allows %s", (input, expected) => {
    expect(sanitizeMarkdownUrl(input)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,hello",
    "file:///tmp/private",
    "ftp://example.com/file",
    "//example.com/path",
    "/relative/path",
    "#fragment",
    " https://example.com",
    "https://user:secret@example.com",
    `https://example.com/${"a".repeat(2_100)}`
  ])("rejects %s", (input) => {
    expect(sanitizeMarkdownUrl(input)).toBeNull();
  });

  it("counts UTF-8 bytes and validates the configured ceiling", () => {
    expect(validateMarkdownInput("🙂", 4)).toEqual({
      byteLength: 4,
      ok: true
    });
    expect(validateMarkdownInput("🙂x", 4)).toEqual({
      byteLength: 5,
      maxBytes: 4,
      ok: false,
      reason: "oversized"
    });
    expect(() => validateMarkdownInput("text", -1)).toThrow(RangeError);
  });
});

describe("SecureMarkdown rendering", () => {
  let adapters: MarkdownPlatformAdapters;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    adapters = {
      openExternal: vi.fn(),
      writeClipboard: vi.fn()
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const render = async (
    source: string,
    extra: Partial<React.ComponentProps<typeof SecureMarkdown>> = {}
  ) => {
    await act(async () =>
      root.render(
        createElement(SecureMarkdown, {
          adapters,
          source,
          ...extra
        })
      )
    );
  };

  it("renders GFM without enabling raw HTML", async () => {
    await render(
      [
        "| Name | State |",
        "| --- | --- |",
        "| Koed | ready |",
        "",
        "- [x] checked",
        "",
        "<script>globalThis.pwned = true</script>",
        '<img src=x onerror="globalThis.pwned = true">'
      ].join("\n")
    );

    expect(container.querySelector("table")?.textContent).toContain("Koed");
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it("routes allowed links through the external-platform adapter", async () => {
    await render("[Koed](https://example.com/docs)");
    const link = container.querySelector('[role="link"]');
    expect(link?.textContent).toBe("Koed");

    await act(async () => (link as HTMLButtonElement | null)?.click());
    expect(adapters.openExternal).toHaveBeenCalledWith(
      "https://example.com/docs"
    );
  });

  it("renders malicious and relative links inert", async () => {
    await render(
      "[script](javascript:alert(1)) [data](data:text/html,pwned) [local](/admin)"
    );

    expect(container.querySelectorAll('[role="link"]')).toHaveLength(0);
    expect(container.textContent).toContain("script");
    expect(container.textContent).toContain("data");
    expect(container.textContent).toContain("local");
    expect(adapters.openExternal).not.toHaveBeenCalled();
  });

  it("disables remote images while retaining useful alt text", async () => {
    await render("![architecture](https://example.com/private.png)");

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[role="img"]')?.textContent).toBe(
      "architecture"
    );
  });

  it("copies fenced code only through the clipboard adapter", async () => {
    await render("```ts\nconst safe = true;\n```");
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Copy code");

    await act(async () => button?.click());
    expect(adapters.writeClipboard).toHaveBeenCalledWith("const safe = true;");
    expect(button?.textContent).toBe("Copied");
  });

  it("reports adapter failures and leaves copy state unchanged", async () => {
    const copyError = new Error("clipboard denied");
    adapters.writeClipboard = vi.fn(() => Promise.reject(copyError));
    const onActionError = vi.fn();
    await render("```\nsecret\n```", { onActionError });
    const button = container.querySelector("button");

    await act(async () => button?.click());
    expect(onActionError).toHaveBeenCalledWith(copyError, "copy");
    expect(button?.textContent).toBe("Copy");
  });

  it("reports external-open failures without throwing from the click", async () => {
    const openError = new Error("platform rejected URL");
    adapters.openExternal = vi.fn(() => {
      throw openError;
    });
    const onActionError = vi.fn();
    await render("[mail](mailto:user@example.com)", { onActionError });

    await act(async () =>
      (
        container.querySelector('[role="link"]') as HTMLButtonElement | null
      )?.click()
    );
    expect(onActionError).toHaveBeenCalledWith(openError, "open-external");
  });

  it("refuses oversized input before rendering Markdown", async () => {
    const onOversizedInput = vi.fn();
    await render("[unsafe](javascript:alert(1))", {
      maxInputBytes: 8,
      onOversizedInput,
      oversizedFallback: createElement("span", null, "Content omitted")
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Content omitted"
    );
    expect(container.querySelector('[role="link"]')).toBeNull();
    expect(onOversizedInput).toHaveBeenCalledWith({
      actualBytes: 29,
      maxBytes: 8
    });
  });
});
