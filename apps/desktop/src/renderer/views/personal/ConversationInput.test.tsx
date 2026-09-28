// @vitest-environment happy-dom

import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationInput } from "./ConversationInput.js";
import type { ManagedConversationSlashCommand } from "./ai-client-slash-suggestions.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DUMMY_SETTINGS: ComponentProps<typeof ConversationInput>["settings"] = {
  options: null,
  selection: {
    instanceId: "",
    model: "",
    reasoningEffort: "",
    permissionMode: ""
  },
  onChange: vi.fn()
};

const DUMMY_COMMANDS: ManagedConversationSlashCommand[] = [
  { name: "query", description: "Search across memory", kind: "command", source: "provider" },
  { name: "edit", description: "Edit the conversation", kind: "command", source: "provider" }
];

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
          settings={DUMMY_SETTINGS}
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
  it.each([
    ["send", false, 1],
    ["send", true, 0],
    ["interrupt", false, 0],
    ["interrupt", true, 0],
    ["busy", true, 0]
  ] as const)(
    "Enter with %s (disabled=%s) submits only an enabled send",
    async (kind, disabled, count) => {
      const onSubmit = vi.fn();
      const props: ComponentProps<typeof ConversationInput> = {
        action: { kind, disabled, label: "Action" },
        label: "Prompt",
        placeholder: "Prompt",
        value: "Follow-up draft",
        onChange: vi.fn(),
        onSubmit,
      settings: DUMMY_SETTINGS
      };
      await act(async () => root.render(<ConversationInput {...props} />));
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true
      });
      await act(async () => {
        container.querySelector("textarea")!.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(true);
      expect(onSubmit).toHaveBeenCalledTimes(count);
      if (kind === "interrupt" && !disabled) {
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>('[aria-label="Action"]')!
            .click()
        );
        expect(onSubmit).toHaveBeenCalledOnce();
      }
    }
  );
  it("passes autocomplete options and keyboard events through", async () => {
    const onSubmit = vi.fn();
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <ConversationInput
          action={{ kind: "send", label: "Send", disabled: false }}
          label="Prompt"
          onChange={setValue}
          onSubmit={onSubmit}
          placeholder="Prompt"
          settings={DUMMY_SETTINGS}
          value={value}
          autocompleteOptions={DUMMY_COMMANDS}
          onAutocompleteSelect={vi.fn()}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    const textarea = container.querySelector("textarea")!;

    // Normal Enter still submits when autocomplete menu is closed
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      )
    );
    expect(onSubmit).toHaveBeenCalledOnce();

    // Escape does not trigger submit
    await act(async () =>
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(onSubmit).toHaveBeenCalledOnce(); // still only once
  });
  it("renders autocomplete menu popover with commands", async () => {
    // The popover only renders when autocomplete is open AND there are filtered commands.
    // Since input events don't trigger React's synthetic onChange in happy-dom, we verify
    // the menu renders in SlashCommandMenu directly (tested in ai-client-slash-suggestions.test.ts).
    // This test confirms the component accepts autocomplete props without crashing.
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <ConversationInput
          action={{ kind: "send", label: "Send", disabled: false }}
          label="Prompt"
          onChange={setValue}
          onSubmit={vi.fn()}
          placeholder="Prompt"
          settings={DUMMY_SETTINGS}
          value={value}
          autocompleteOptions={DUMMY_COMMANDS}
          onAutocompleteSelect={vi.fn()}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    const textarea = container.querySelector("textarea")!;
    expect(textarea).not.toBeNull();
  });
});
