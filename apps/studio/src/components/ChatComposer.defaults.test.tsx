// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChatComposer, type ChatComposerSelection } from "./ChatComposer";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const key = "koed:chat:last-model-reasoning:v1";
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});
async function mount(
  options: {
    initialModel?: string;
    initialEffort?: string;
    preferRememberedDefaults?: boolean;
    agents?: React.ComponentProps<typeof ChatComposer>["agents"];
    allowMultipleAgentMentions?: boolean;
    uncontrolled?: boolean;
    activeAgentId?: string | null;
    onActiveAgentChange?: React.ComponentProps<
      typeof ChatComposer
    >["onActiveAgentChange"];
    onAgentMention?: React.ComponentProps<
      typeof ChatComposer
    >["onAgentMention"];
  } = {},
  accepted = true
) {
  const sent = vi.fn<
    (text: string, selection: ChatComposerSelection) => void | false
  >(() => (accepted ? undefined : false));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("No gateway in unit test"))
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <ChatComposer
        placeholder="Message"
        projectName="Personal"
        branch="local"
        {...(options.uncontrolled ? {} : { value: "Hello" })}
        onSend={sent}
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
          },
          {
            provider: "claude",
            id: "model-c",
            displayName: "Model C",
            instanceId: "client-c",
            supportedReasoningEfforts: ["high"]
          }
        ]}
        {...options}
      />
    )
  );
  return sent;
}
async function send() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Send message"]')!
      .click()
  );
}
it("a fresh composer sends with the last used model and reasoning", async () => {
  window.localStorage.setItem(
    key,
    JSON.stringify({ modelKey: "codex:model-b", effort: "high" })
  );
  const sent = await mount();
  await send();
  expect(sent.mock.calls[0]?.[1]).toMatchObject({
    model: "model-b",
    effort: "high"
  });
});
it("explicit conversation settings take priority over remembered defaults", async () => {
  window.localStorage.setItem(
    key,
    JSON.stringify({ modelKey: "codex:model-b", effort: "high" })
  );
  const sent = await mount({
    initialModel: "codex:model-a",
    initialEffort: "medium"
  });
  await send();
  expect(sent.mock.calls[0]?.[1]).toMatchObject({
    model: "model-a",
    effort: "medium"
  });
});
it("Home fallback settings allow the remembered defaults to take priority", async () => {
  window.localStorage.setItem(
    key,
    JSON.stringify({ modelKey: "codex:model-b", effort: "high" })
  );
  const sent = await mount({
    initialModel: "codex:model-a",
    initialEffort: "medium",
    preferRememberedDefaults: true
  });
  await send();
  expect(sent.mock.calls[0]?.[1]).toMatchObject({
    model: "model-b",
    effort: "high"
  });
});
it("failed submissions do not change the last used settings", async () => {
  const saved = JSON.stringify({ modelKey: "codex:model-b", effort: "high" });
  window.localStorage.setItem(key, saved);
  await mount(
    { initialModel: "codex:model-a", initialEffort: "medium" },
    false
  );
  await send();
  expect(window.localStorage.getItem(key)).toBe(saved);
});

it("keeps the conversation model and effort when selecting Agent recipients", async () => {
  const agents = [
    {
      id: "agent-a",
      name: "Ada",
      mentionToken: "ada_a1",
      role: "Planner",
      lifecycle: "active" as const,
      defaultProvider: "codex",
      defaultModel: "model-a",
      defaultReasoningEffort: "medium",
      currentVersion: 3
    },
    {
      id: "agent-b",
      name: "Bex",
      mentionToken: "bex_b2",
      role: "Reviewer",
      lifecycle: "active" as const,
      defaultProvider: "claude",
      defaultModel: "model-c",
      defaultReasoningEffort: "high",
      currentVersion: 5
    }
  ];
  const sent = await mount({
    agents,
    initialModel: "codex:model-a",
    initialEffort: "medium",
    allowMultipleAgentMentions: true,
    uncontrolled: true
  });
  const typeDraft = async (text: string) => {
    const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(input, text);
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const choose = async (name: string, draft: string) => {
    await typeDraft(draft);
    const option = [...container.querySelectorAll('[role="option"]')].find(
      (item) => item.textContent?.includes(name)
    ) as HTMLButtonElement;
    await act(async () => option.click());
  };
  const clickButton = async (button: HTMLButtonElement) => {
    await act(async () => button.click());
  };
  const selectModel = async (label: string) => {
    await clickButton(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Select model and effort"]'
      )!
    );
    const dialog = container.querySelector(
      '[role="dialog"][aria-label="Model and reasoning"]'
    )!;
    const currentModel = [...dialog.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Model A")
    ) as HTMLButtonElement;
    await clickButton(currentModel);
    const option = [...dialog.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label
    ) as HTMLButtonElement;
    await clickButton(option);
  };

  await choose("Ada", "@Ada");
  await selectModel("Model B");
  const adaToken = container.querySelector("textarea")!.value.trim();
  await choose(
    "Bex",
    `${container.querySelector("textarea")!.value.trim()} @Bex`
  );
  await clickButton(
    container.querySelector<HTMLButtonElement>(
      '[aria-label="Edit settings for Ada, recipient 1"]'
    )!
  );
  expect(
    container.querySelector('[aria-label="Select model and effort"]')
      ?.textContent
  ).toContain("Model B");
  await typeDraft(`${adaToken} @bex_b2 ${adaToken} Review both.`);
  await send();

  expect(sent.mock.calls[0]?.[1].recipients).toEqual([
    expect.objectContaining({
      agentId: "agent-a",
      expectedAgentVersion: 3,
      provider: "codex",
      model: "model-b",
      effort: "medium"
    }),
    expect.objectContaining({
      agentId: "agent-b",
      expectedAgentVersion: 5,
      provider: "codex",
      model: "model-b",
      effort: "medium"
    })
  ]);
});

it("lets a selected Agent respondent be cleared to generic", async () => {
  const sent = await mount({
    agents: [
      {
        id: "agent-a",
        name: "Ada",
        mentionToken: "ada_a1",
        role: "Planner",
        lifecycle: "active",
        defaultProvider: "codex",
        defaultModel: "model-a",
        defaultReasoningEffort: "medium"
      }
    ],
    initialModel: "codex:model-a",
    initialEffort: "medium",
    allowMultipleAgentMentions: true,
    uncontrolled: true
  });
  const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!.call(input, "@Ada");
    input.setSelectionRange(4, 4);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const option = [...container.querySelectorAll('[role="option"]')].find(
    (item) => item.textContent?.includes("Ada")
  ) as HTMLButtonElement;
  await act(async () => option.click());
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!.call(input, "Please help with this.");
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const clear = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Use generic AI Client")
  ) as HTMLButtonElement;
  await act(async () => clear.click());
  await send();
  expect(sent.mock.calls[0]?.[1]).toMatchObject({
    agentId: null,
    recipients: []
  });
});

it("removing a new mention preserves the existing recipient execution settings", async () => {
  const agents = [
    {
      id: "agent-a",
      name: "Ada",
      mentionToken: "ada_a1",
      role: "Planner",
      lifecycle: "active" as const,
      defaultProvider: "codex",
      defaultModel: "model-a",
      defaultReasoningEffort: "medium"
    },
    {
      id: "agent-b",
      name: "Bex",
      mentionToken: "bex_b2",
      role: "Reviewer",
      lifecycle: "active" as const,
      defaultProvider: "claude",
      defaultModel: "model-c",
      defaultReasoningEffort: "high"
    }
  ];
  const activeAgentChange = vi.fn();
  const agentMention = vi.fn();
  const sent = await mount({
    agents,
    initialModel: "claude:model-c:client-c",
    initialEffort: "high",
    allowMultipleAgentMentions: true,
    activeAgentId: "agent-b",
    onActiveAgentChange: activeAgentChange,
    onAgentMention: agentMention,
    uncontrolled: true
  });
  const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const editDraft = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(input, text);
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await editDraft("@Ada");
  const option = [...container.querySelectorAll('[role="option"]')].find(
    (item) => item.textContent?.includes("Ada")
  ) as HTMLButtonElement;
  await act(async () => option.click());
  await editDraft("Please review this.");
  await send();

  expect(agentMention).not.toHaveBeenCalled();
  expect(activeAgentChange).not.toHaveBeenCalled();
  expect(sent.mock.calls[0]?.[1]).toMatchObject({
    agentId: "agent-b",
    recipients: [
      expect.objectContaining({
        agentId: "agent-b",
        provider: "claude",
        model: "model-c",
        effort: "high"
      })
    ]
  });
});

it("removing the only selected mention sends as a generic turn", async () => {
  const sent = await mount({
    agents: [
      {
        id: "agent-a",
        name: "Ada",
        mentionToken: "ada_a1",
        role: "Planner",
        lifecycle: "active",
        defaultProvider: "codex",
        defaultModel: "model-a",
        defaultReasoningEffort: "medium"
      }
    ],
    initialModel: "codex:model-a",
    initialEffort: "medium",
    allowMultipleAgentMentions: true,
    uncontrolled: true
  });
  const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const editDraft = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(input, text);
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await editDraft("@Ada");
  const option = [...container.querySelectorAll('[role="option"]')].find(
    (item) => item.textContent?.includes("Ada")
  ) as HTMLButtonElement;
  await act(async () => option.click());
  await editDraft("Please help with this.");
  await send();

  expect(sent.mock.calls[0]?.[1]).toMatchObject({
    agentId: null,
    recipients: []
  });
});
