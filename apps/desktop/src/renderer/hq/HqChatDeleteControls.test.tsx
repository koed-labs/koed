// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HqChatDeleteControls,
  type ChatDeleteRequest
} from "./HqChatDeleteControls.js";

describe("HQ chat deletion controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const onUndo = vi.fn();
  const onRetry = vi.fn();
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const render = async (
    request: ChatDeleteRequest | null,
    notice: Parameters<typeof HqChatDeleteControls>[0]["notice"] = null
  ) =>
    act(async () =>
      root.render(
        <HqChatDeleteControls
          request={request}
          notice={notice}
          busy={false}
          onCancel={onCancel}
          onConfirm={onConfirm}
          onDismiss={vi.fn()}
          onUndo={onUndo}
          onRetry={onRetry}
        />
      )
    );

  it("shows running-work confirmation, traps focus, and restores focus on Escape", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    await render({
      projectId: "p",
      sessionId: "s",
      title: "Koed chat",
      mode: "delete",
      running: true
    });
    expect(host.textContent).toContain("Koed will stop it after you confirm");
    const dialog = host.querySelector('[role="alertdialog"]')!;
    const buttons = dialog.querySelectorAll("button");
    expect(document.activeElement).toBe(buttons[0]);
    buttons[1]!.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true
      })
    );
    expect(document.activeElement).toBe(buttons[0]);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    expect(onCancel).toHaveBeenCalledOnce();
    await render(null);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("keeps Delete pending separate from completed Undo and Forget", async () => {
    await render({
      projectId: "p",
      sessionId: "s",
      title: "Koed chat",
      mode: "forget",
      running: false
    });
    expect(host.textContent).toContain("Personal recall");
    expect(host.textContent).toContain("7 days");
    await act(async () =>
      (
        host.querySelector("button.hq-chat-delete__danger") as HTMLButtonElement
      ).click()
    );
    expect(onConfirm).toHaveBeenCalledOnce();
    await render(null, {
      kind: "pending",
      sessionId: "s",
      batchId: "b",
      message: "Deletion pending"
    });
    expect(host.textContent).toContain("Check status");
    expect(host.textContent).not.toContain("Undo");
    await render(null, {
      kind: "deleted",
      sessionId: "s",
      batchId: "b",
      message: "Moved to Deleted"
    });
    expect(host.textContent).toContain("Undo");
  });
});
