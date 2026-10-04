// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
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
