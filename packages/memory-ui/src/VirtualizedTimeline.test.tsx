// @vitest-environment happy-dom

import { act, createElement, createRef, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  VirtualizedTimelineHandle,
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
    scroll: 600,
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
      scroll: 600,
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
    controllerRef?: Ref<VirtualizedTimelineHandle>;
    events?: Event[];
    hasOlderEvents?: boolean;
    olderPageKey?: string;
    onAtEndChange?: (atEnd: boolean) => void;
    onLoadOlder?: () => Promise<void> | void;
    onLoadingOlderChange?: (loading: boolean) => void;
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
      scroll: 600,
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

  it("leaves new messages unpinned while reading, then explicitly jumps to the end", async () => {
    const controllerRef = createRef<VirtualizedTimelineHandle>();
    await renderTimeline({ controllerRef });
    listMock.getState.mockReturnValue({
      contentLength: 1000,
      scrollLength: 500,
      isAtEnd: false,
      isStartReached: false,
      scroll: 600
    });
    act(() => listMock.props?.onScroll?.());
    listMock.scrollToEnd.mockClear();
    await renderTimeline({
      controllerRef,
      events: [event("e1"), event("e2"), event("e3")]
    });
    expect(listMock.scrollToEnd).not.toHaveBeenCalled();
    act(() => controllerRef.current?.scrollToEnd());
    expect(listMock.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    listMock.scrollToEnd.mockClear();
    await renderTimeline({
      controllerRef,
      events: [event("e1"), event("e2"), event("e3"), event("e4")]
    });
    expect(listMock.scrollToEnd).toHaveBeenCalled();
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

  const nearStart = () =>
    listMock.getState.mockReturnValue({
      contentLength: 1000,
      scrollLength: 500,
      scroll: 200,
      isAtEnd: false,
      isStartReached: true
    });

  it("prefetches before reaching the top and reports the pending request", async () => {
    const page = Promise.withResolvers<void>();
    const onLoadOlder = vi.fn(() => page.promise);
    const onLoadingOlderChange = vi.fn();
    await renderTimeline({ onLoadOlder, onLoadingOlderChange });
    nearStart();
    await act(async () => {
      listMock.props?.onScroll?.();
      listMock.props?.onStartReached?.();
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onLoadingOlderChange).toHaveBeenLastCalledWith(true);
    await act(async () => page.resolve());
    expect(onLoadingOlderChange).toHaveBeenLastCalledWith(false);
    await act(async () => listMock.props?.onScroll?.());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("continues after a prepend without requiring the reader to leave the loading boundary", async () => {
    const firstPage = Promise.withResolvers<void>();
    const nextPage = Promise.withResolvers<void>();
    const onLoadOlder = vi
      .fn()
      .mockImplementationOnce(() => firstPage.promise)
      .mockImplementationOnce(() => nextPage.promise);
    await renderTimeline({ onLoadOlder });
    nearStart();
    await act(async () => listMock.props?.onScroll?.());
    listMock.scrollToEnd.mockClear();
    await renderTimeline({
      onLoadOlder,
      events: [event("e0"), event("e1"), event("e2")]
    });
    await act(async () => listMock.props?.onStartReached?.());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    await act(async () => firstPage.resolve());
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
    expect(listMock.scrollToEnd).not.toHaveBeenCalled();
    await act(async () => nextPage.resolve());
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("also continues when the prepended data commits after the load promise settles", async () => {
    const onLoadOlder = vi.fn().mockResolvedValue(undefined);
    await renderTimeline({ onLoadOlder });
    nearStart();
    await act(async () => listMock.props?.onScroll?.());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    await renderTimeline({
      onLoadOlder,
      events: [event("e0"), event("e1"), event("e2")]
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("uses the source cursor even when older tools extend the same visible group", async () => {
    const onLoadOlder = vi.fn().mockResolvedValue(undefined);
    const events = [event("stable-tool-group")];
    await renderTimeline({ events, olderPageKey: "tool-20", onLoadOlder });
    nearStart();
    await act(async () => listMock.props?.onScroll?.());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    await renderTimeline({ events, olderPageKey: "tool-10", onLoadOlder });
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("does not automatically loop on a failed page, but permits retry after leaving the boundary", async () => {
    const onLoadOlder = vi.fn().mockRejectedValue(new Error("offline"));
    const onPageLoadError = vi.fn();
    await renderTimeline({ onLoadOlder, onPageLoadError });
    nearStart();
    await act(async () => listMock.props?.onScroll?.());
    await act(async () => listMock.props?.onStartReached?.());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onPageLoadError).toHaveBeenCalledTimes(1);
    listMock.getState.mockReturnValue({
      contentLength: 1200,
      scrollLength: 500,
      scroll: 600,
      isAtEnd: false,
      isStartReached: false
    });
    act(() => listMock.props?.onScroll?.());
    nearStart();
    await act(async () => listMock.props?.onScroll?.());
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
  });

  it("ignores an old thread's page completion while the new thread is loading", async () => {
    const oldPage = Promise.withResolvers<void>();
    const newPage = Promise.withResolvers<void>();
    const onPageLoadError = vi.fn();
    const oldLoader = vi.fn(() => oldPage.promise);
    const newLoader = vi.fn(() => newPage.promise);
    const onLoadingOlderChange = vi.fn();
    await renderTimeline({
      onLoadOlder: oldLoader,
      onPageLoadError,
      onLoadingOlderChange
    });
    nearStart();
    await act(async () => listMock.props?.onStartReached?.());
    await renderTimeline({
      threadKey: "thread-b",
      events: [event("b")],
      onLoadOlder: newLoader,
      onPageLoadError,
      onLoadingOlderChange
    });
    await act(async () => listMock.props?.onStartReached?.());
    expect(newLoader).toHaveBeenCalledTimes(1);
    await act(async () => oldPage.reject(new Error("old failure")));
    expect(onPageLoadError).not.toHaveBeenCalled();
    expect(onLoadingOlderChange).toHaveBeenLastCalledWith(true);
    await act(async () => listMock.props?.onStartReached?.());
    expect(newLoader).toHaveBeenCalledTimes(1);
    await act(async () => newPage.resolve());
    expect(onLoadingOlderChange).toHaveBeenLastCalledWith(false);
  });
});
