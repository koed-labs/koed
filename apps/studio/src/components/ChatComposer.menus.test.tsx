// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  vi.restoreAllMocks();
});

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ChatComposer
        placeholder="Continue"
        projectName="Personal"
        branch="main"
        onSend={() => undefined}
        initialModel="codex:model-a"
        initialEffort="medium"
        modelOptions={[
          {
            provider: "codex",
            id: "model-a",
            displayName: "Model A",
            supportedReasoningEfforts: ["medium", "high"]
          },
          {
            provider: "codex",
            id: "model-b",
            displayName: "Model B",
            supportedReasoningEfforts: ["medium", "high"]
          }
        ]}
      />
    );
  });
}

const trigger = () =>
  container.querySelector<HTMLButtonElement>(
    '[aria-label="Select model and effort"]'
  )!;
const isOpen = () => trigger().getAttribute("aria-expanded") === "true";
async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("chat control menu dismissal", () => {
  it.each([
    { top: 100, bottom: 128, side: "top-full", height: 360 },
    { top: 320, bottom: 348, side: "bottom-full", height: 304 }
  ])(
    "fits the model popup into available space at $top px",
    async ({ top, bottom, side, height }) => {
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        top,
        bottom,
        left: 0,
        right: 220,
        width: 220,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({})
      });
      await mount();
      await click(trigger());
      const popup = container.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(popup.classList.contains(side)).toBe(true);
      expect(popup.style.maxHeight).toBe(`${height}px`);
      await click(popup.querySelector<HTMLButtonElement>("button.flex-col")!);
      expect(popup.style.maxHeight).toBe(`${height}px`);
    }
  );

  it("closes after choosing a model or reasoning effort", async () => {
    await mount();
    await click(trigger());
    const menu = container.querySelector('[data-composer-menu="model"]')!;
    await click(menu.querySelector<HTMLButtonElement>("button.flex-col")!);
    await click(
      [...menu.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Model B"
      )!
    );
    expect(isOpen()).toBe(false);
    expect(trigger().textContent).toContain("Model B");
    await click(trigger());
    await click(
      container.querySelector<HTMLButtonElement>('[aria-label="High"]')!
    );
    expect(isOpen()).toBe(false);
    expect(trigger().textContent).toContain("High");
  });

  it("closes when clicking the draft inside the composer and with Escape", async () => {
    await mount();
    await click(trigger());
    await act(async () => {
      container.querySelector("textarea")!.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "touch"
        })
      );
    });
    expect(isOpen()).toBe(false);
    await click(trigger());
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(isOpen()).toBe(false);
  });

  it("keeps the popup open when interacting with its own controls", async () => {
    await mount();
    await click(trigger());
    await act(async () => {
      trigger().dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true })
      );
    });
    expect(isOpen()).toBe(true);
    await click(trigger());
    expect(isOpen()).toBe(false);
  });
});
