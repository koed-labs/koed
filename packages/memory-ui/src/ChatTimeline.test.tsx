// @vitest-environment happy-dom

import { act, createElement, createRef, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatTimelineHandle, ChatTimelineProps } from "./ChatTimeline.js";
import type {
  ChatTimelineMessage,
  ChatTimelineRow
} from "./chatTimelineRows.js";

type Message = ChatTimelineMessage & { body: string };

type MockListProps = {
  data: Array<ChatTimelineRow<Message>>;
  keyExtractor: (row: ChatTimelineRow<Message>) => string;
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
      item: ChatTimelineRow<Message>;
      key: string;
    }>;
  }) => void;
  renderItem: (props: { item: ChatTimelineRow<Message> }) => ReactNode;
  viewabilityConfig: unknown;
};

const listMock = vi.hoisted(() => ({
  getState: vi.fn(() => ({
    contentLength: 1_000,
    isAtEnd: true,
    isStartReached: false,
    scrollLength: 500
  })),
  props: null as MockListProps | null,
  scrollToEnd: vi.fn(() => Promise.resolve()),
  scrollToIndex: vi.fn(() => Promise.resolve())
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
        scrollToEnd: listMock.scrollToEnd,
        scrollToIndex: listMock.scrollToIndex
      }));
      return React.createElement(
        "div",
        { "data-testid": "legend-list" },
        props.data.map((row) =>
          React.createElement(
            "div",
            { key: props.keyExtractor(row) },
            props.renderItem({ item: row })
          )
        )
      );
    })
  };
});

import { ChatTimeline } from "./ChatTimeline.js";

const makeMessage = (
  id: string,
  minute: number,
  senderId = "alice"
): Message => ({
  body: id,
  id,
  senderId,
  timestamp: `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`
});

const utcDay = (item: Message) => item.timestamp.slice(0, 10);

const baseProps = (
  overrides: Partial<ChatTimelineProps<Message>> = {}
): ChatTimelineProps<Message> => ({
  firstUnreadMessageId: "m2",
  grouping: { getDayKey: utcDay },
  hasOlderMessages: true,
  messages: [makeMessage("m1", 0), makeMessage("m2", 1)],
  onLoadOlder: vi.fn(),
  renderDayDivider: (row) => createElement("hr", { "data-row": row.key }),
  renderFirstUnread: (row) =>
    createElement("span", { "data-row": row.key }, "New"),
  renderGroup: (row) =>
    createElement("span", { "data-row": row.key }, row.senderId),
  renderMessage: (row) =>
    createElement("span", { "data-row": row.key }, row.message.body),
  threadKey: "thread-a",
  ...overrides
});

const deferred = <T,>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

describe("ChatTimeline", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    listMock.props = null;
    listMock.getState.mockReturnValue({
      contentLength: 1_000,
      isAtEnd: true,
      isStartReached: false,
      scrollLength: 500
    });
    listMock.scrollToEnd.mockClear();
    listMock.scrollToIndex.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("passes stable normalized rows and anchor preservation to LegendList", async () => {
    await act(async () =>
      root.render(createElement(ChatTimeline<Message>, baseProps()))
    );

    expect(listMock.props?.data.map((row) => row.key)).toEqual([
      "day:2026-01-01",
      "group:m1",
      "message:m1",
      "first-unread:m2",
      "message:m2"
    ]);
    expect(listMock.props?.maintainVisibleContentPosition).toEqual({
      data: true,
      size: true
    });
    expect(listMock.props?.viewabilityConfig).toEqual({
      itemVisiblePercentThreshold: 1
    });
  });

  it("reports sorted visible message ranges and end-state transitions", async () => {
    const onAtEndChange = vi.fn();
    const onVisibleRangeChange = vi.fn();
    await act(async () =>
      root.render(
        createElement(
          ChatTimeline<Message>,
          baseProps({ onAtEndChange, onVisibleRangeChange })
        )
      )
    );

    const messageRows =
      listMock.props?.data.filter((row) => row.kind === "message") ?? [];
    listMock.getState.mockReturnValue({
      contentLength: 1_000,
      isAtEnd: false,
      isStartReached: false,
      scrollLength: 500
    });
    act(() => {
      listMock.props?.onViewableItemsChanged?.({
        changed: [],
        viewableItems: [
          {
            containerId: 2,
            index: 4,
            isViewable: true,
            item: messageRows[1]!,
            key: messageRows[1]!.key
          },
          {
            containerId: 1,
            index: 2,
            isViewable: true,
            item: messageRows[0]!,
            key: messageRows[0]!.key
          }
        ]
      });
      listMock.props?.onScroll?.();
      listMock.props?.onScroll?.();
    });

    expect(onVisibleRangeChange).toHaveBeenLastCalledWith({
      endIndex: 4,
      endKey: "message:m2",
      firstVisibleMessageId: "m1",
      lastVisibleMessageId: "m2",
      startIndex: 2,
      startKey: "message:m1",
      visibleMessageIds: ["m1", "m2"]
    });
    expect(onAtEndChange.mock.calls.map(([value]) => value)).toEqual([
      true,
      false
    ]);
  });

  it("treats a non-scrollable timeline as being at its end", async () => {
    const onAtEndChange = vi.fn();
    await act(async () =>
      root.render(
        createElement(ChatTimeline<Message>, baseProps({ onAtEndChange }))
      )
    );

    listMock.getState.mockReturnValue({
      contentLength: 500,
      isAtEnd: false,
      isStartReached: true,
      scrollLength: 500
    });
    act(() => {
      listMock.props?.onScroll?.();
      listMock.props?.onViewableItemsChanged?.({
        changed: [],
        viewableItems: []
      });
    });

    expect(onAtEndChange).toHaveBeenCalledTimes(1);
    expect(onAtEndChange).toHaveBeenLastCalledWith(true);
  });

  it("jumps to the unread divider and falls back to the end", async () => {
    const handle = createRef<ChatTimelineHandle>();
    await act(async () =>
      root.render(
        createElement(ChatTimeline<Message>, {
          ...baseProps(),
          ref: handle
        })
      )
    );
    listMock.scrollToIndex.mockClear();
    listMock.scrollToEnd.mockClear();

    await expect(
      handle.current?.jumpToFirstUnread({ animated: false })
    ).resolves.toBe(true);
    expect(listMock.scrollToIndex).toHaveBeenCalledWith({
      animated: false,
      index: 3,
      viewPosition: 0
    });

    await act(async () =>
      root.render(
        createElement(ChatTimeline<Message>, {
          ...baseProps({ firstUnreadMessageId: null }),
          ref: handle
        })
      )
    );
    listMock.scrollToEnd.mockClear();
    await expect(handle.current?.jumpToFirstUnread()).resolves.toBe(false);
    expect(listMock.scrollToEnd).toHaveBeenCalledWith({ animated: true });
  });

  it("allows only one paging request in flight across both directions", async () => {
    const older = deferred<void>();
    const onLoadOlder = vi.fn(() => older.promise);
    const onLoadNewer = vi.fn();
    await act(async () =>
      root.render(
        createElement(
          ChatTimeline<Message>,
          baseProps({
            hasNewerMessages: true,
            onLoadNewer,
            onLoadOlder
          })
        )
      )
    );

    act(() => {
      listMock.props?.onStartReached?.();
      listMock.props?.onStartReached?.();
      listMock.props?.onEndReached?.();
    });
    await act(async () => Promise.resolve());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onLoadNewer).not.toHaveBeenCalled();

    await act(async () => older.resolve());
    act(() => listMock.props?.onEndReached?.());
    await act(async () => Promise.resolve());
    expect(onLoadNewer).toHaveBeenCalledTimes(1);
  });

  it("reports synchronous and asynchronous page errors without rejection leaks", async () => {
    const onPageLoadError = vi.fn();
    const syncError = new Error("sync older failure");
    const asyncError = new Error("async newer failure");
    const onLoadOlder = vi.fn(() => {
      throw syncError;
    });
    const onLoadNewer = vi.fn(() => Promise.reject(asyncError));
    listMock.getState.mockReturnValue({
      contentLength: 100,
      isAtEnd: false,
      isStartReached: true,
      scrollLength: 500
    });

    await act(async () =>
      root.render(
        createElement(
          ChatTimeline<Message>,
          baseProps({
            hasNewerMessages: true,
            onLoadNewer,
            onLoadOlder,
            onPageLoadError
          })
        )
      )
    );
    act(() => listMock.props?.onStartReached?.());
    await act(async () => Promise.resolve());
    expect(onPageLoadError).toHaveBeenCalledWith(syncError, "older");

    act(() => listMock.props?.onEndReached?.());
    await act(async () => Promise.resolve());
    expect(onPageLoadError).toHaveBeenCalledWith(asyncError, "newer");
  });

  it("preserves an unpinned prepend anchor without forcing an end jump", async () => {
    await act(async () =>
      root.render(
        createElement(
          ChatTimeline<Message>,
          baseProps({ messages: [makeMessage("m2", 1)] })
        )
      )
    );
    listMock.scrollToEnd.mockClear();
    listMock.getState.mockReturnValue({
      contentLength: 1_000,
      isAtEnd: false,
      isStartReached: false,
      scrollLength: 500
    });
    act(() => listMock.props?.onScroll?.());

    await act(async () =>
      root.render(
        createElement(
          ChatTimeline<Message>,
          baseProps({
            messages: [makeMessage("m1", 0), makeMessage("m2", 1)]
          })
        )
      )
    );

    expect(listMock.scrollToEnd).not.toHaveBeenCalled();
    expect(listMock.props?.data.some((row) => row.key === "message:m2")).toBe(
      true
    );
  });

  it("resets thread state, ignores stale errors, and permits new-thread paging", async () => {
    const oldLoad = deferred<void>();
    const onPageLoadError = vi.fn();
    const oldOnLoad = vi.fn(() => oldLoad.promise);
    const newOnLoad = vi.fn();
    const onVisibleRangeChange = vi.fn();
    await act(async () =>
      root.render(
        createElement(
          ChatTimeline<Message>,
          baseProps({
            onLoadOlder: oldOnLoad,
            onPageLoadError,
            onVisibleRangeChange
          })
        )
      )
    );
    act(() => listMock.props?.onStartReached?.());
    await act(async () => Promise.resolve());
    listMock.scrollToEnd.mockClear();

    await act(async () =>
      root.render(
        createElement(
          ChatTimeline<Message>,
          baseProps({
            messages: [makeMessage("n1", 0)],
            onLoadOlder: newOnLoad,
            onPageLoadError,
            onVisibleRangeChange,
            threadKey: "thread-b"
          })
        )
      )
    );
    expect(listMock.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(onVisibleRangeChange).toHaveBeenLastCalledWith(null);

    act(() => listMock.props?.onStartReached?.());
    await act(async () => Promise.resolve());
    expect(newOnLoad).toHaveBeenCalledTimes(1);

    await act(async () => oldLoad.reject(new Error("stale failure")));
    expect(onPageLoadError).not.toHaveBeenCalled();
  });
});
