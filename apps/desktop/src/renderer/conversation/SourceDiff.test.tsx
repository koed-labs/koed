// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({
    fileDiff,
    options,
    renderHeaderPrefix
  }: {
    fileDiff: { name: string };
    options: {
      collapsed: boolean;
      theme: { light: string; dark: string };
    };
    renderHeaderPrefix: () => ReactNode;
  }) =>
    createElement(
      "div",
      {
        "data-collapsed": String(options.collapsed),
        "data-file": fileDiff.name,
        "data-theme": `${options.theme.light}:${options.theme.dark}`
      },
      renderHeaderPrefix(),
      options.collapsed
        ? null
        : createElement("pre", null, `diff:${fileDiff.name}`)
    )
}));

import { SourceDiff } from "./SourceDiff.js";

const patch = `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** Update File: src/other.ts
@@
-before
+after
*** End Patch`;

describe("SourceDiff", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows file headers and expands one file at a time", async () => {
    await act(async () => root.render(<SourceDiff sourceText={patch} />));
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(2);
    expect(container.querySelectorAll('[data-collapsed="true"]')).toHaveLength(
      2
    );
    expect(
      container
        .querySelector('[data-file="src/app.ts"]')
        ?.getAttribute("data-theme")
    ).toBe("pierre-light-soft:pierre-dark-soft");

    await act(async () => buttons[0]!.click());
    expect(container.querySelectorAll('[data-collapsed="false"]')).toHaveLength(
      1
    );
    expect(container.textContent).toContain("diff:src/app.ts");

    await act(async () => buttons[1]!.click());
    expect(container.querySelectorAll('[data-collapsed="false"]')).toHaveLength(
      1
    );
    expect(container.textContent).toContain("diff:src/other.ts");
    expect(container.textContent).not.toContain("diff:src/app.ts");
  });

  it("renders an explained bounded raw fallback", async () => {
    await act(async () =>
      root.render(<SourceDiff sourceText="*** Begin Patch\n*** End Patch" />)
    );
    expect(
      container.querySelector('[aria-label="Raw source change"]')
    ).not.toBeNull();
    expect(container.textContent).toContain("could not be parsed");
    expect(container.textContent).toContain("*** Begin Patch");
  });
});
