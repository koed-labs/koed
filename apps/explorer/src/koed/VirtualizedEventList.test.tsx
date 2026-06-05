// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GraphEvent } from "./types";

const legendListMock = vi.hoisted(() => ({
  getState: vi.fn(() => ({
    contentLength: 1000,
    isAtEnd: false,
    isStartReached: false,
    scrollLength: 500
  })),
  scrollToEnd: vi.fn()
}));

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");
  return {
    LegendList: React.forwardRef(function MockLegendList(
      props: {
        data: GraphEvent[];
        extraData: unknown;
        keyExtractor: (event: GraphEvent) => string;
        onScroll?: () => void;
        renderItem: (props: {
          extraData: unknown;
          item: GraphEvent;
        }) => ReactNode;
      },
      ref
    ) {
      React.useImperativeHandle(ref, () => ({
        getState: legendListMock.getState,
        scrollToEnd: legendListMock.scrollToEnd
      }));
      return React.createElement(
        "div",
        {
          "data-testid": "legend-list",
          onScroll: props.onScroll
        },
        props.data.map((event) =>
          React.createElement(
            "div",
            { key: props.keyExtractor(event) },
            props.renderItem({ extraData: props.extraData, item: event })
          )
        )
      );
    })
  };
});

import { VirtualizedEventList } from "./VirtualizedEventList";

const makeEvent = (threadKey: string, index: number): GraphEvent => ({
  actor: "assistant",
  captureMethod: "hook",
  contentPreview: `event ${index}`,
  eventType: "captured",
  id: `${threadKey}-event-${index}`,
  invalidatedAt: null,
  invalidationReason: null,
  linkedNodeIds: [],
  metadata: {},
  model: "gpt-test",
  projectId: "project",
  projectName: "Project",
  projectPath: "/tmp/project",
  rawContent: `full event ${index}`,
  sessionId: null,
  sourceRuntime: "codex-cli",
  threadId: threadKey,
  threadName: threadKey,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  sourceEventTime: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  sourceSequence: index,
  capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  visibility: "personal",
  workspaceId: "project"
});

describe("VirtualizedEventList", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    legendListMock.getState.mockReturnValue({
      contentLength: 1000,
      isAtEnd: false,
      isStartReached: false,
      scrollLength: 500
    });
    legendListMock.scrollToEnd.mockClear();
    vi.stubGlobal(
      "requestAnimationFrame",
      (callback: FrameRequestCallback): number => {
        callback(performance.now());
        return 1;
      }
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("repins and scrolls to the end when the selected thread changes", async () => {
    await act(async () => {
      root.render(
        createElement(VirtualizedEventList, {
          events: [makeEvent("thread-a", 1)],
          hasOlderEvents: true,
          onLoadOlder: vi.fn(),
          onSelectEvent: vi.fn(),
          selectedEventId: "thread-a-event-1",
          threadKey: "project:thread-a"
        })
      );
    });

    legendListMock.scrollToEnd.mockClear();
    const list = container.querySelector('[data-testid="legend-list"]');
    await act(async () => {
      list?.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await act(async () => {
      root.render(
        createElement(VirtualizedEventList, {
          events: [makeEvent("thread-b", 1)],
          hasOlderEvents: true,
          onLoadOlder: vi.fn(),
          onSelectEvent: vi.fn(),
          selectedEventId: "thread-b-event-1",
          threadKey: "project:thread-b"
        })
      );
    });

    expect(legendListMock.scrollToEnd).toHaveBeenCalled();
  });

  it("does not steal scroll for live events when the selected thread is unpinned", async () => {
    await act(async () => {
      root.render(
        createElement(VirtualizedEventList, {
          events: [makeEvent("thread-a", 1)],
          hasOlderEvents: true,
          onLoadOlder: vi.fn(),
          onSelectEvent: vi.fn(),
          selectedEventId: "thread-a-event-1",
          threadKey: "project:thread-a"
        })
      );
    });

    legendListMock.scrollToEnd.mockClear();
    const list = container.querySelector('[data-testid="legend-list"]');
    await act(async () => {
      list?.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    await act(async () => {
      root.render(
        createElement(VirtualizedEventList, {
          events: [makeEvent("thread-a", 1), makeEvent("thread-a", 2)],
          hasOlderEvents: true,
          onLoadOlder: vi.fn(),
          onSelectEvent: vi.fn(),
          selectedEventId: "thread-a-event-1",
          threadKey: "project:thread-a"
        })
      );
    });

    expect(legendListMock.scrollToEnd).not.toHaveBeenCalled();
  });
});
