// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const agent = {
  id: "agent-a",
  name: "Analyst",
  role: "Analyst",
  lifecycle: "active" as const,
  defaultProvider: "codex",
  defaultModel: "model-a",
  defaultReasoningEffort: "medium"
};
const models = ["model-a", "model-b"].map((id) => ({
  provider: "codex",
  id,
  instanceId: "client-a",
  supportedReasoningEfforts: ["medium", "high"]
}));
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});
async function mount(
  overrides: Partial<React.ComponentProps<typeof ChatComposer>> = {}
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const send = vi.fn();
  await act(async () =>
    root.render(
      <ChatComposer
        placeholder="Message channel"
        projectName="Shared Project"
        branch="shared"
        agents={[agent]}
        teamMembers={[{ id: "human-a", name: "Maya" }]}
        modelOptions={models}
        showMetaBar={false}
        showExecutionControls={false}
        switchToExecutionControlsOnMention
        showFormattingToolbar
        onSend={send}
        {...overrides}
      />
    )
  );
  return send;
}
async function type(text: string) {
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )!.set!.call(input, text);
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(selector: string) {
  await act(async () =>
    (container.querySelector(selector) as HTMLButtonElement).click()
  );
}
const controls = () =>
  container.querySelector('[aria-label="Select model and effort"]');
it("keeps normal controls while typing @ and selecting a human", async () => {
  const send = await mount();
  expect(controls()).toBeNull();
  await type("@");
  expect(container.querySelector('[role="listbox"]')).not.toBeNull();
  expect(controls()).toBeNull();
  const human = [...container.querySelectorAll('[role="option"]')].find((b) =>
    b.textContent?.includes("Maya")
  )!;
  await act(async () => (human as HTMLButtonElement).click());
  expect(controls()).toBeNull();
  expect(container.querySelector('[aria-label="Local execution"]')).toBeNull();
  await click('[aria-label="Send message"]');
  expect(send).toHaveBeenCalledWith(
    expect.stringContaining("@"),
    expect.objectContaining({ agentId: null, mentionUserIds: ["human-a"] }),
    undefined
  );
});
it("enters Agent mode only on selection, retains identity for thread-style uncontrolled composers, and sends the chosen model", async () => {
  const send = await mount();
  await type("@Analyst");
  expect(controls()).toBeNull();
  await click('[role="option"]');
  expect(controls()).not.toBeNull();
  expect(
    container.querySelector('[aria-label="Local execution"]')?.tagName
  ).toBe("SPAN");
  expect(container.textContent).toContain("Shared Project");
  await click('[aria-label="Select model and effort"]');
  // Open the model list using its menu button.
  const modelList = [...container.querySelectorAll("button")].find(
    (b) =>
      b.textContent?.includes("model-a") &&
      b.getAttribute("aria-label") !== "Select model and effort"
  )!;
  await act(async () => modelList.click());
  const alternative = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "model-b"
  )!;
  await act(async () => alternative.click());
  await click('[aria-label="Send message"]');
  expect(send).toHaveBeenCalledWith(
    expect.stringContaining("@Analyst"),
    expect.objectContaining({
      agentId: "agent-a",
      provider: "codex",
      model: "model-b",
      instanceId: "client-a"
    }),
    undefined
  );
  expect(controls()).toBeNull();
});
it("returns to human messaging when the Agent mention is removed without losing other text", async () => {
  await mount();
  await type("@Analyst");
  await click('[role="option"]');
  await type("Keep this text");
  expect(controls()).toBeNull();
  expect(container.querySelector("textarea")?.value).toBe("Keep this text");
});
it("honours handed-off settings ahead of Agent defaults", async () => {
  const send = await mount({
    activeAgentId: agent.id,
    initialModel: "codex:model-b:client-a",
    initialEffort: "high",
    initialPermissionMode: "read",
    value: "A retained prompt"
  });
  await click('[aria-label="Send message"]');
  expect(send).toHaveBeenCalledWith(
    "A retained prompt",
    expect.objectContaining({
      model: "model-b",
      effort: "high",
      permissionMode: "read",
      instanceId: "client-a"
    }),
    undefined
  );
});
it("leaves a colleague Agent's execution settings to its owner", async () => {
  await mount({ agents: [{ ...agent, teamRequestOnly: true }] });
  await type("@Analyst");
  await click('[role="option"]');
  expect(container.textContent).toContain(
    "The Agent owner chooses execution settings."
  );
  expect(controls()).toBeNull();
});

it("cancels Agent mode while retaining the typed message", async () => {
  await mount();
  await type("@Analyst");
  await click('[role="option"]');
  const previous = container.querySelector("textarea")!.value;
  await click('[aria-label="Stop addressing Agent"]');
  expect(controls()).toBeNull();
  expect(container.querySelector("textarea")?.value).toBe(previous);
});

it("shows unavailable-model warnings only after selecting an owned Agent", async () => {
  await mount({
    modelOptions: [],
    modelAvailabilityWarning: "AI models are unavailable."
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await type("@");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  const choice = [...container.querySelectorAll('[role="option"]')].find((b) =>
    b.textContent?.includes("Analyst")
  )!;
  await act(async () => (choice as HTMLButtonElement).click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "AI models are unavailable."
  );
  expect((controls() as HTMLButtonElement).disabled).toBe(true);
});
