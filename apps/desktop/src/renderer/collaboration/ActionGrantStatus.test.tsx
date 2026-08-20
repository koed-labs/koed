// @vitest-environment happy-dom

import { ToastProvider } from "@koed/ui";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CollaborationActionGrantProjection,
  CollaborationRendererClient
} from "../../collaboration/renderer-client.js";
import { ActionGrantStatus } from "./ActionGrantStatus.js";

const grant = (
  state: CollaborationActionGrantProjection["state"],
  operation = "Share Memory"
): CollaborationActionGrantProjection => ({
  expiresAt: "2026-08-11T12:00:00.000Z",
  id: "action-grant-1",
  operation,
  retryable: false,
  state
});

describe("ActionGrantStatus", () => {
  let container: HTMLDivElement;
  let root: Root;
  const cancelActionGrant = vi.fn(async () => undefined);
  const client = {
    cancelActionGrant
  } as unknown as CollaborationRendererClient;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  const render = async (
    actionGrants: readonly CollaborationActionGrantProjection[]
  ) => {
    await act(async () =>
      root.render(
        <ToastProvider>
          <ActionGrantStatus actionGrants={actionGrants} client={client} />
        </ToastProvider>
      )
    );
  };

  it("replaces an approval state with a top-centred toast and dismisses it", async () => {
    await render([grant("awaiting_approval")]);

    let toast = document.body.querySelector<HTMLElement>("[data-toast]");
    expect(toast?.textContent).toContain("Share Memory");
    expect(toast?.textContent).toContain("Waiting for browser approval");
    expect(toast?.textContent).toContain("Cancel");
    expect(toast?.parentElement?.className).toContain("top-4");
    expect(document.body.querySelector(".desktop-action-grants")).toBeNull();

    await render([grant("completed")]);
    const toasts = document.body.querySelectorAll<HTMLElement>("[data-toast]");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.textContent).toContain("Complete");
    expect(toasts[0]?.dataset.tone).toBe("success");

    await act(async () => vi.advanceTimersByTimeAsync(5_001));
    toast = document.body.querySelector<HTMLElement>("[data-toast]");
    expect(toast).toBeNull();
  });

  it("keeps the pending approval cancellation action", async () => {
    await render([grant("awaiting_approval")]);
    const cancel = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel"
    );
    expect(cancel).toBeDefined();

    await act(async () => cancel?.click());
    expect(cancelActionGrant).toHaveBeenCalledWith("action-grant-1");
    expect(document.body.querySelector("[data-toast]")).toBeNull();
  });

  it("does not toast Shared Memory preview approval states", async () => {
    await render([grant("awaiting_approval", "Preview Shared Memory")]);
    expect(document.body.querySelector("[data-toast]")).toBeNull();

    await render([grant("completed", "Preview Shared Memory")]);
    expect(document.body.querySelector("[data-toast]")).toBeNull();
  });
});
