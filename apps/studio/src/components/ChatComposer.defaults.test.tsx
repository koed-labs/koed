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
        value="Hello"
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
