// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  ManagedMemoryAction,
  ManagedMemoryActionDesktopApi
} from "../../../ipc/managed-memory-action-protocol.js";
import { ManagedMemoryActions } from "./ManagedMemoryActions.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const executionA = "11111111-1111-4111-8111-111111111111";
const executionB = "22222222-2222-4222-8222-222222222222";
const action: ManagedMemoryAction = {
  id: "33333333-3333-4333-8333-333333333333",
  executionId: executionA,
  actionKind: "forget",
  state: "completed",
  outcome: "forgotten",
  message: "Forgot this memory. Undo is available for seven days.",
  assertionId: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-10-20T10:00:00Z",
  completedAt: "2026-10-20T10:01:00Z"
};

it("reloads a durable result and Undo without receiving a suppression token", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let current = action;
  const api: ManagedMemoryActionDesktopApi = {
    list: vi.fn().mockImplementation(() => Promise.resolve([current])),
    undo: vi.fn().mockImplementation(() => {
      current = {
        ...action,
        outcome: "undone",
        message: "Restored this memory."
      };
      return Promise.resolve(current);
    })
  };
  try {
    await act(async () =>
      root.render(<ManagedMemoryActions api={api} executionId={executionA} />)
    );
    expect(container.textContent).toContain("Forgot this memory");
    await act(async () => container.querySelector("button")!.click());
    expect(api.undo).toHaveBeenCalledWith(executionA, action.id);
    expect(container.textContent).toContain("Restored this memory");
    await act(async () => root.unmount());
    const reloaded = createRoot(container);
    await act(async () =>
      reloaded.render(
        <ManagedMemoryActions
          api={{
            ...api,
            list: vi.fn().mockResolvedValue([
              {
                ...action,
                outcome: "undone",
                message: "Restored this memory."
              }
            ])
          }}
          executionId={executionA}
        />
      )
    );
    expect(container.textContent).toContain("Restored this memory");
    await act(async () => reloaded.unmount());
  } finally {
    container.remove();
  }
});

it("discards an Undo response after execution identity changes", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let resolveUndo!: (value: ManagedMemoryAction) => void;
  const undoPending = new Promise<ManagedMemoryAction>((resolve) => {
    resolveUndo = resolve;
  });
  const onChanged = vi.fn();
  const api: ManagedMemoryActionDesktopApi = {
    list: vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(id === executionA ? [action] : [])
      ),
    undo: vi.fn().mockReturnValue(undoPending)
  };
  try {
    await act(async () =>
      root.render(
        <ManagedMemoryActions
          api={api}
          executionId={executionA}
          onChanged={onChanged}
        />
      )
    );
    await act(async () => container.querySelector("button")!.click());
    await act(async () =>
      root.render(
        <ManagedMemoryActions
          api={api}
          executionId={executionB}
          onChanged={onChanged}
        />
      )
    );
    await act(async () =>
      resolveUndo({
        ...action,
        outcome: "undone",
        message: "Restored this memory."
      })
    );
    expect(container.textContent).not.toContain("Restored this memory");
    expect(onChanged).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("reports an unavailable source chat without forgetting it", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const offer = {
    ...action,
    outcome: "offer_chat_forget" as const,
    message: "Review the source chat",
    sourceSessionId: "55555555-5555-4555-8555-555555555555"
  };
  const onOfferChatForget = vi.fn().mockResolvedValue(false);
  const api: ManagedMemoryActionDesktopApi = {
    list: vi.fn().mockResolvedValue([offer]),
    undo: vi.fn()
  };
  try {
    await act(async () =>
      root.render(
        <ManagedMemoryActions
          api={api}
          executionId={executionA}
          onOfferChatForget={onOfferChatForget}
        />
      )
    );
    await act(async () => container.querySelector("button")!.click());
    expect(onOfferChatForget).toHaveBeenCalledWith(offer.sourceSessionId);
    expect(container.textContent).toContain("The source chat is unavailable");
    expect(api.undo).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
