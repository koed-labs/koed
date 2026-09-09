// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationInput } from "./ConversationInput.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ConversationInput", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("owns shared keyboard, composition, settings, and action behavior", async () => {
    const onSubmit = vi.fn();
    function Harness() {
      const [value, setValue] = useState("Draft");
      return (
        <ConversationInput
          action={{ kind: "send", label: "Send message", disabled: false }}
          label="Conversation message"
          onChange={setValue}
          onSubmit={onSubmit}
          placeholder="Tell the agent what to do"
          settings={{
            options: null,
            selection: {
              instanceId: "",
              model: "",
              reasoningEffort: "",
              permissionMode: ""
            },
            onChange: vi.fn()
          }}
          value={value}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    const textarea = container.querySelector("textarea")!;

    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    );
    expect(onSubmit).toHaveBeenCalledOnce();

    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true
        })
      )
    );
    expect(onSubmit).toHaveBeenCalledOnce();

    await act(async () => {
      textarea.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true })
      );
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
      textarea.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true })
      );
    });
    expect(onSubmit).toHaveBeenCalledOnce();

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!
        .click()
    );
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".conversation-settings")).not.toBeNull();
  });
});
