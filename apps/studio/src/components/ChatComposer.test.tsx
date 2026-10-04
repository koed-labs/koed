import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatComposer } from "./ChatComposer";

const clients = ["computer-a", "computer-b"].map((instanceId) => ({
  provider: "codex",
  id: "gpt-6.1-sol",
  displayName: "GPT-6.1 Sol",
  instanceId,
  supportedReasoningEfforts: ["medium"]
}));

function canContinue(instanceId: string, options = clients) {
  const html = renderToStaticMarkup(
    <ChatComposer
      placeholder="Continue"
      projectName="Personal"
      branch="main"
      value="Continue our work"
      onSend={() => undefined}
      modelOptions={options}
      restoreSelection={{
        key: "saved-chat",
        provider: "codex",
        model: "gpt-6.1-sol",
        instanceId,
        effort: "medium",
        permissionMode: "ask"
      }}
    />
  );
  const button = html.match(/<button[^>]*aria-label="Send message"[^>]*>/)?.[0];
  expect(button).toBeDefined();
  return !button!.includes('disabled=""');
}

describe("saved chat AI Client selection", () => {
  it("can continue on the original computer when another offers the same model", () => {
    expect(canContinue("computer-a")).toBe(true);
  });
  it("also resolves the original client when it is the only choice", () => {
    expect(canContinue("computer-a", [clients[0]!])).toBe(true);
  });
  it("resolves the local client identity when a hosted identity is also advertised", () => {
    expect(
      canContinue(
        "computer-a",
        clients.map((client) => ({
          ...client,
          hostedInstanceId: `hosted-${client.instanceId}`
        }))
      )
    ).toBe(true);
  });
  it("does not silently substitute another computer if the original disappears", () => {
    expect(canContinue("computer-a", [clients[1]!])).toBe(false);
  });
});
