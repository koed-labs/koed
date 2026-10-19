// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ManagedConversationRuntimeItem } from "../../../ipc/managed-conversation-protocol.js";
import { HqRuntimeItem } from "./HqRuntimeItem.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const base: ManagedConversationRuntimeItem = {
  id: "item-1",
  executionGeneration: 3,
  providerTurnId: null,
  providerItemId: null,
  itemKind: "command_approval",
  presentation: {
    mode: "expanded",
    renderer: "approval",
    policyKey: "",
    policyRevision: 1,
    reason: ""
  },
  state: "pending",
  payload: { command: ["echo", "safe"], supportsSessionApproval: true },
  revision: 1,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
  answered: false
};

it("offers exact permission decisions only while an approval is pending", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onRespond = vi.fn();
  try {
    await act(async () =>
      root.render(
        <HqRuntimeItem item={base} busy={false} onRespond={onRespond} />
      )
    );
    expect(container.textContent).toContain("Always allow this session");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Always allow"))!
        .click()
    );
    expect(onRespond).toHaveBeenCalledWith({ decision: "acceptForSession" });
    await act(async () =>
      root.render(
        <HqRuntimeItem
          item={{ ...base, answered: true, state: "answered" }}
          busy={false}
          onRespond={onRespond}
        />
      )
    );
    expect(container.querySelector("button")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("passes answer arrays and marks an unlisted Other answer as a user note", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onRespond = vi.fn();
  const item: ManagedConversationRuntimeItem = {
    ...base,
    itemKind: "user_input",
    presentation: { ...base.presentation, renderer: "user_input" },
    payload: {
      questions: [
        {
          id: "choice",
          header: "Choose",
          isOther: true,
          options: [{ label: "Known" }]
        }
      ]
    }
  };
  try {
    await act(async () =>
      root.render(
        <HqRuntimeItem item={item} busy={false} onRespond={onRespond} />
      )
    );
    const input = container.querySelector("input")!;
    input.value = "Something else";
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
    expect(onRespond).toHaveBeenCalledWith({
      answers: { choice: ["user_note: Something else"] }
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
