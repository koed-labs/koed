// @vitest-environment happy-dom

import { act, createElement, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TimelineItem,
  TimelineVisibleRange
} from "./VirtualizedTimeline.js";

type Event = TimelineItem & { body: string };

type MockListProps = {
  data: Event[];
  maintainVisibleContentPosition: unknown;
  onEndReached?: () => void;
  onScroll?: () => void;
  onStartReached?: () => void;
  onViewableItemsChanged?: (info: {
    changed: unknown[];
    viewableItems: Array<{
      containerId: number;
      index: number;
      isViewable: boolean;
      item: Event;
      key: string;
    }>;
  }) => void;
  renderItem: (props: { item: Event }) => ReactNode;
};

const listMock = vi.hoisted(() => ({
  getState: vi.fn(() => ({
    contentLength: 1_000,
    isAtEnd: true,
    isStartReached: false,
    scrollLength: 500
  })),
  props: null as MockListProps | null,
  scrollToEnd: vi.fn(() => Promise.resolve())
}));

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");
  return {
    LegendList: React.forwardRef(function MockLegendList(
      props: MockListProps,
      ref: Ref<unknown>
    ) {
      listMock.props = props;
      React.useImperativeHandle(ref, () => ({
        getState: listMock.getState,
        scrollToEnd: listMock.scrollToEnd
      }));
      return React.createElement(
        "div",
        null,
        props.data.map((event) =>
          React.createElement(
            "div",
            { key: event.id },
            props.renderItem({ item: event })
          )
        )
      );
    })
  };
});

import { VirtualizedTimeline } from "./VirtualizedTimeline.js";

const event = (id: string): Event => ({ body: id, id });

describe("VirtualizedTimeline compatibility callbacks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    listMock.props = null;
    listMock.scrollToEnd.mockClear();
    listMock.getState.mockReturnValue({
      contentLength: 1_000,
      isAtEnd: true,
      isStartReached: false,
      scrollLength: 500
    });
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
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const renderTimeline = async ({
    events = [event("e1"), event("e2")],
    ...overrides
  }: {
    events?: Event[];
    hasOlderEvents?: boolean;
    onAtEndChange?: (atEnd: boolean) => void;
    onLoadOlder?: () => Promise<void> | void;
    onPageLoadError?: (error: unknown, direction: "newer" | "older") => void;
    onVisibleRangeChange?: (range: TimelineVisibleRange<Event> | null) => void;
    threadKey?: string;
  } = {}) => {
    await act(async () =>
      root.render(
        createElement(VirtualizedTimeline<Event>, {
          events,
          hasOlderEvents: true,
          onLoadOlder: vi.fn(),
          renderEvent: (item) => item.body,
          threadKey: "thread-a",
          ...overrides
        })
      )
    );
  };

  it("keeps anchor behavior while reporting visible events and end state", async () => {
    const onAtEndChange = vi.fn();
    const onVisibleRangeChange = vi.fn();
    await renderTimeline({ onAtEndChange, onVisibleRangeChange });

    expect(listMock.props?.maintainVisibleContentPosition).toEqual({
      data: true,
      size: true
    });
    const items = listMock.props?.data ?? [];
    listMock.getState.mockReturnValue({
      contentLength: 1_000,
      isAtEnd: false,
      isStartReached: false,
      scrollLength: 500
    });
    act(() => {
      listMock.props?.onScroll?.();
      listMock.props?.onViewableItemsChanged?.({
        changed: [],
        viewableItems: [
          {
            containerId: 1,
            index: 0,
            isViewable: true,
            item: items[0]!,
            key: items[0]!.id
          },
          {
            containerId: 2,
            index: 1,
            isViewable: true,
            item: items[1]!,
            key: items[1]!.id
          }
        ]
      });
    });

    expect(onAtEndChange).toHaveBeenCalledWith(false);
    expect(onVisibleRangeChange).toHaveBeenLastCalledWith({
      endIndex: 1,
      endItem: items[1],
      startIndex: 0,
      startItem: items[0],
      visibleItems: items
    });
  });

  it("captures synchronous page failures and prevents duplicate loads", async () => {
    const error = new Error("load failed");
    const onLoadOlder = vi.fn(() => {
      throw error;
    });
    const onPageLoadError = vi.fn();
    await renderTimeline({ onLoadOlder, onPageLoadError });

    act(() => {
      listMock.props?.onStartReached?.();
      listMock.props?.onStartReached?.();
    });
    await act(async () => Promise.resolve());

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onPageLoadError).toHaveBeenCalledWith(error, "older");
  });

  it("clears the reported range and repins when a thread changes", async () => {
    const onVisibleRangeChange = vi.fn();
    await renderTimeline({ onVisibleRangeChange });
    listMock.scrollToEnd.mockClear();
    onVisibleRangeChange.mockClear();

    await renderTimeline({
      events: [event("new")],
      onVisibleRangeChange,
      threadKey: "thread-b"
    });

    expect(onVisibleRangeChange).toHaveBeenCalledWith(null);
    expect(listMock.scrollToEnd).toHaveBeenCalled();
  });
});
