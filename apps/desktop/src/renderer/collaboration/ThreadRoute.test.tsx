// @vitest-environment happy-dom

import { act, createElement, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  CollaborationMessagePage,
  CollaborationThread
} from "@koed/shared/collaboration";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");
  return {
    LegendList: React.forwardRef(function MockLegendList(
      props: {
        data: unknown[];
        renderItem: (item: { item: unknown }) => ReactNode;
      },
      _ref: Ref<unknown>
    ) {
      return React.createElement(
        "div",
        null,
        props.data.map((item, index) =>
          React.createElement("div", { key: index }, props.renderItem({ item }))
        )
      );
    })
  };
});

import { ThreadTimeline } from "./ThreadRoute.js";

it("shows an actionable error when copying a message fails, then clears it on retry", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const writeClipboard = vi
    .fn()
    .mockRejectedValueOnce(new Error("clipboard denied"))
    .mockResolvedValueOnce(undefined);
  const page = {
    items: [
      {
        id: "message",
        threadId: "thread",
        scope: "personal",
        teamId: null,
        sequence: 1,
        sender: { id: "alice", displayName: "Alice" },
        senderKind: "user",
        body: "Hello",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        editedAt: null,
        deletedAt: null,
        delivery: "sent",
        recipientStatus: null,
        failure: null
      }
    ],
    hasOlder: false,
    hasNewer: false,
    olderCursor: null,
    newerCursor: null
  } as CollaborationMessagePage;
  const thread = {
    id: "thread",
    scope: "personal",
    kind: "personal_channel",
    lastReadSequence: 1,
    unreadCount: 0
  } as CollaborationThread;
  const client = {
    markDelivered: vi.fn().mockResolvedValue(undefined)
  } as unknown as CollaborationRendererClient;
  try {
    await act(async () =>
      root.render(
        createElement(ThreadTimeline, {
          client,
          currentUserId: "alice",
          label: "Test",
          markdownAdapters: { writeClipboard, openExternal: vi.fn() },
          page,
          thread
        })
      )
    );
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Copy message")
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not copy message. Try again."
    );
    await act(async () => button!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(writeClipboard).toHaveBeenCalledWith("Hello");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
