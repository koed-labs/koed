// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SlashCommandMenu } from "./SlashCommandMenu.js";

it("scrolls the keyboard selection into view without moving focus", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const scroll = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  const options = Array.from({ length: 30 }, (_, index) => ({
    name: `command-${index}`,
    description: "",
    kind: "command" as const,
    source: "provider" as const,
    scope: "global" as const
  }));
  try {
    await act(async () =>
      root.render(
        <SlashCommandMenu
          options={options}
          selectedIndex={0}
          onSelect={vi.fn()}
        />
      )
    );
    scroll.mockClear();
    await act(async () =>
      root.render(
        <SlashCommandMenu
          options={options}
          selectedIndex={20}
          onSelect={vi.fn()}
        />
      )
    );
    expect(scroll).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest"
    });
    expect(scroll.mock.instances[0]).toBe(
      container.querySelector('[aria-selected="true"]')
    );
    expect(document.activeElement).toBe(document.body);
    scroll.mockClear();
    await act(async () =>
      root.render(
        <SlashCommandMenu
          options={options}
          selectedIndex={0}
          onSelect={vi.fn()}
        />
      )
    );
    expect(scroll).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    HTMLElement.prototype.scrollIntoView = original;
    container.remove();
  }
});
