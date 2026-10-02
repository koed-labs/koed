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
  {
    name: "query",
    description: "Search across memory",
    kind: "command",
    source: "provider",
    scope: "global"
  },
  {
    name: "edit",
    description: "Edit the conversation",
    kind: "command",
    source: "provider",
    scope: "project"
  }
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
  const typeInput = async (textarea: HTMLTextAreaElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(textarea, value);
      textarea.setSelectionRange(value.length, value.length);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const pressKey = async (
    textarea: HTMLTextAreaElement,
    key: string,
    options: KeyboardEventInit = {}
  ) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...options
    });
    await act(async () => {
      textarea.dispatchEvent(event);
    });
    return event;
  };

  it.each(["Enter", "Tab"])(
    "%s accepts the keyboard-selected suggestion without submitting",
    async (key) => {
      const onSubmit = vi.fn();
      const onSelect = vi.fn();
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
            onAutocompleteSelect={onSelect}
          />
        );
      }
      await act(async () => root.render(<Harness />));
      const textarea = container.querySelector("textarea")!;
      await typeInput(textarea, "/");
      expect(container.textContent).toContain("Search across memory");
      await pressKey(textarea, "ArrowDown");
      const event = await pressKey(textarea, key);
      expect(event.defaultPrevented).toBe(true);
      expect(textarea.value).toBe("/edit ");
      expect(onSelect).toHaveBeenCalledWith(DUMMY_COMMANDS[1]);
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );

  const mountAutocomplete = async (
    options: ManagedConversationSlashCommand[] = DUMMY_COMMANDS,
    diagnostics: { loading?: boolean; error?: string | null } = {}
  ) => {
    const onSubmit = vi.fn();
    const onSelect = vi.fn();
    function Harness({
      commands
    }: {
      commands: ManagedConversationSlashCommand[];
    }) {
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
          autocompleteOptions={commands}
          autocompleteLoading={diagnostics.loading}
          autocompleteError={diagnostics.error}
          onAutocompleteSelect={onSelect}
        />
      );
    }
    await act(async () => root.render(<Harness commands={options} />));
    const textarea = container.querySelector("textarea")!;
    return {
      textarea,
      onSubmit,
      onSelect,
      updateOptions: async (commands: ManagedConversationSlashCommand[]) => {
        await act(async () => root.render(<Harness commands={commands} />));
      }
    };
  };

  it.each([
    ["Enter", { shiftKey: true }],
    ["Tab", { shiftKey: true }],
    ["Enter", { isComposing: true }]
  ] as const)(
    "preserves %s modifier/composition behavior with suggestions open (%j)",
    async (key, options) => {
      const { textarea, onSubmit, onSelect } = await mountAutocomplete();
      await typeInput(textarea, "/");
      const event = await pressKey(textarea, key, options);
      expect(event.defaultPrevented).toBe(false);
      expect(textarea.value).toBe("/");
      expect(onSelect).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );

  it.each([
    [false, null, "No matching commands."],
    [true, null, "Loading commands…"],
    [false, "Discovery failed", "Discovery failed"]
  ] as const)(
    "diagnostic menu does not trap submission or focus navigation (%s, %s)",
    async (loading, error, message) => {
      const { textarea, onSubmit, onSelect } = await mountAutocomplete([], {
        loading,
        error
      });
      await typeInput(textarea, "/unknown");
      expect(container.textContent).toContain(message);
      expect((await pressKey(textarea, "Tab")).defaultPrevented).toBe(false);
      expect((await pressKey(textarea, "ArrowDown")).defaultPrevented).toBe(
        false
      );
      await pressKey(textarea, "Enter");
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onSelect).not.toHaveBeenCalled();
    }
  );

  it("selects the first asynchronously discovered suggestion", async () => {
    const { textarea, onSubmit, updateOptions } = await mountAutocomplete([]);
    await typeInput(textarea, "/");
    await updateOptions(DUMMY_COMMANDS);
    await pressKey(textarea, "Enter");
    expect(textarea.value).toBe("/query ");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps selection valid when filtering reduces the results", async () => {
    const { textarea, onSubmit } = await mountAutocomplete();
    await typeInput(textarea, "/");
    await pressKey(textarea, "ArrowDown");
    await typeInput(textarea, "/qu");
    await pressKey(textarea, "Tab");
    expect(textarea.value).toBe("/query ");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps selection valid when discovery replaces the results", async () => {
    const { textarea, onSubmit, updateOptions } = await mountAutocomplete();
    await typeInput(textarea, "/");
    await pressKey(textarea, "ArrowDown");
    await updateOptions([DUMMY_COMMANDS[0]!]);
    await pressKey(textarea, "Tab");
    expect(textarea.value).toBe("/query ");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("composition events prevent autocomplete selection", async () => {
    const { textarea, onSubmit, onSelect } = await mountAutocomplete();
    await typeInput(textarea, "/");
    await act(async () => {
      textarea.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true })
      );
    });
    expect((await pressKey(textarea, "Enter")).defaultPrevented).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      textarea.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true })
      );
    });
    await pressKey(textarea, "Enter");
    expect(textarea.value).toBe("/query ");
  });

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
  it.each([
    [true, null, "Loading commands…"],
    [false, "Command discovery failed.", "Command discovery failed."],
    [false, null, "No matching commands."]
  ] as const)(
    "shows discovery state with no suggestions (loading=%s)",
    async (loading, error, message) => {
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
            autocompleteOptions={[]}
            autocompleteLoading={loading}
            autocompleteError={error}
          />
        );
      }
      await act(async () => root.render(<Harness />));
      const textarea = container.querySelector("textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )!.set!.call(textarea, "/");
        textarea.setSelectionRange(1, 1);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.textContent).toContain(message);
    }
  );

  it("renders autocomplete menu popover with commands", async () => {
    const { textarea } = await mountAutocomplete();
    await typeInput(textarea, "/");
    const options = container.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(2);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(options[1]!.getAttribute("aria-selected")).toBe("false");
  });
});
