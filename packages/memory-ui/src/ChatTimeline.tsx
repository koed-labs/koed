import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
  type ViewToken
} from "@legendapp/list/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ReactNode
} from "react";

import {
  buildChatTimelineRows,
  firstUnreadRowIndex,
  type BuildChatTimelineRowsOptions,
  type ChatDayDividerRow,
  type ChatFirstUnreadRow,
  type ChatGroupRow,
  type ChatMessageRow,
  type ChatTimelineMessage,
  type ChatTimelineRow
} from "./chatTimelineRows.js";

export type ChatTimelinePageDirection = "newer" | "older";

export type ChatTimelineVisibleRange = {
  endIndex: number;
  endKey: string;
  firstVisibleMessageId: string | null;
  lastVisibleMessageId: string | null;
  startIndex: number;
  startKey: string;
  visibleMessageIds: readonly string[];
};

export type ChatTimelineHandle = {
  jumpToEnd: (options?: { animated?: boolean }) => Promise<void>;
  jumpToFirstUnread: (options?: { animated?: boolean }) => Promise<boolean>;
};

export type ChatTimelineProps<M extends ChatTimelineMessage> = {
  ariaLabel?: string;
  className?: string;
  estimatedItemHeight?: number;
  firstUnreadMessageId?: string | null;
  grouping?: Omit<BuildChatTimelineRowsOptions<M>, "firstUnreadMessageId">;
  hasNewerMessages?: boolean;
  hasOlderMessages: boolean;
  messages: readonly M[];
  onAtEndChange?: (atEnd: boolean) => void;
  onLoadNewer?: () => Promise<void> | void;
  onLoadOlder: () => Promise<void> | void;
  onPageLoadError?: (
    error: unknown,
    direction: ChatTimelinePageDirection
  ) => void;
  onVisibleRangeChange?: (range: ChatTimelineVisibleRange | null) => void;
  renderDayDivider: (row: ChatDayDividerRow) => ReactNode;
  renderFirstUnread: (row: ChatFirstUnreadRow) => ReactNode;
  renderGroup: (row: ChatGroupRow<M>) => ReactNode;
  renderMessage: (row: ChatMessageRow<M>) => ReactNode;
  threadKey: string;
};

function visibleRangeFromTokens<M extends ChatTimelineMessage>(
  tokens: readonly ViewToken<ChatTimelineRow<M>>[]
): ChatTimelineVisibleRange | null {
  const visible = tokens
    .filter((token) => token.isViewable && token.index >= 0)
    .sort((left, right) => left.index - right.index);
  if (visible.length === 0) return null;

  const messageIds = visible.flatMap((token) =>
    token.item.kind === "message" ? [token.item.message.id] : []
  );
  const first = visible[0]!;
  const last = visible.at(-1)!;

  return {
    endIndex: last.index,
    endKey: last.item.key,
    firstVisibleMessageId: messageIds[0] ?? null,
    lastVisibleMessageId: messageIds.at(-1) ?? null,
    startIndex: first.index,
    startKey: first.item.key,
    visibleMessageIds: messageIds
  };
}

const timelineIsAtEnd = (state: {
  contentLength: number;
  isAtEnd: boolean;
  scrollLength: number;
}): boolean => state.isAtEnd || state.contentLength <= state.scrollLength + 1;

function ChatTimelineInner<M extends ChatTimelineMessage>(
  {
    ariaLabel,
    className,
    estimatedItemHeight = 88,
    firstUnreadMessageId,
    grouping,
    hasNewerMessages = false,
    hasOlderMessages,
    messages,
    onAtEndChange,
    onLoadNewer,
    onLoadOlder,
    onPageLoadError,
    onVisibleRangeChange,
    renderDayDivider,
    renderFirstUnread,
    renderGroup,
    renderMessage,
    threadKey
  }: ChatTimelineProps<M>,
  forwardedRef: React.ForwardedRef<ChatTimelineHandle>
) {
  const listRef = useRef<LegendListRef | null>(null);
  const atEndRef = useRef<boolean | null>(null);
  const loadInFlightRef = useRef<ChatTimelinePageDirection | null>(null);
  const olderLoadArmedRef = useRef(true);
  const threadGenerationRef = useRef(0);
  const latestRef = useRef({
    hasNewerMessages,
    hasOlderMessages,
    onAtEndChange,
    onLoadNewer,
    onLoadOlder,
    onPageLoadError,
    onVisibleRangeChange
  });
  latestRef.current = {
    hasNewerMessages,
    hasOlderMessages,
    onAtEndChange,
    onLoadNewer,
    onLoadOlder,
    onPageLoadError,
    onVisibleRangeChange
  };

  const rows = useMemo(
    () =>
      buildChatTimelineRows(messages, {
        ...grouping,
        firstUnreadMessageId
      }),
    [firstUnreadMessageId, grouping, messages]
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const reportAtEnd = useCallback((atEnd: boolean) => {
    if (atEndRef.current === atEnd) return;
    atEndRef.current = atEnd;
    latestRef.current.onAtEndChange?.(atEnd);
  }, []);

  const jumpToEnd = useCallback(
    async (options?: { animated?: boolean }) => {
      reportAtEnd(true);
      await Promise.resolve(
        listRef.current?.scrollToEnd?.({
          animated: options?.animated ?? true
        })
      );
    },
    [reportAtEnd]
  );

  const jumpToFirstUnread = useCallback(
    async (options?: { animated?: boolean }): Promise<boolean> => {
      const index = firstUnreadRowIndex(rowsRef.current);
      if (index < 0) {
        await jumpToEnd(options);
        return false;
      }
      reportAtEnd(false);
      await Promise.resolve(
        listRef.current?.scrollToIndex?.({
          animated: options?.animated ?? true,
          index,
          viewPosition: 0
        })
      );
      return true;
    },
    [jumpToEnd, reportAtEnd]
  );

  useImperativeHandle(forwardedRef, () => ({ jumpToEnd, jumpToFirstUnread }), [
    jumpToEnd,
    jumpToFirstUnread
  ]);

  useEffect(() => {
    threadGenerationRef.current += 1;
    loadInFlightRef.current = null;
    olderLoadArmedRef.current = true;
    atEndRef.current = null;
    latestRef.current.onVisibleRangeChange?.(null);
    void jumpToEnd({ animated: false });
  }, [jumpToEnd, threadKey]);

  useEffect(() => {
    if (!hasOlderMessages) {
      olderLoadArmedRef.current = false;
    } else if (loadInFlightRef.current === null) {
      olderLoadArmedRef.current = true;
    }
  }, [hasOlderMessages]);

  const requestPage = useCallback((direction: ChatTimelinePageDirection) => {
    const latest = latestRef.current;
    const canLoad =
      direction === "older"
        ? latest.hasOlderMessages
        : latest.hasNewerMessages && Boolean(latest.onLoadNewer);
    if (!canLoad || loadInFlightRef.current !== null) return;
    if (direction === "older" && !olderLoadArmedRef.current) return;

    const generation = threadGenerationRef.current;
    loadInFlightRef.current = direction;
    if (direction === "older") olderLoadArmedRef.current = false;

    const load =
      direction === "older" ? latest.onLoadOlder : latest.onLoadNewer;
    let failed = false;
    void Promise.resolve()
      .then(() => load?.())
      .catch((error: unknown) => {
        failed = true;
        if (generation === threadGenerationRef.current) {
          latestRef.current.onPageLoadError?.(error, direction);
        }
      })
      .finally(() => {
        if (generation !== threadGenerationRef.current) return;
        loadInFlightRef.current = null;
        if (direction !== "older") return;
        if (failed) {
          olderLoadArmedRef.current = latestRef.current.hasOlderMessages;
          return;
        }

        const state = listRef.current?.getState?.();
        const isScrollable =
          state && state.contentLength > state.scrollLength + 1;
        olderLoadArmedRef.current = Boolean(
          latestRef.current.hasOlderMessages &&
          (!state?.isStartReached || !isScrollable)
        );
      });
  }, []);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (!state) return;
    if (!state.isStartReached) olderLoadArmedRef.current = true;
    reportAtEnd(timelineIsAtEnd(state));
  }, [reportAtEnd]);

  const handleViewableItemsChanged = useCallback(
    ({
      viewableItems
    }: {
      viewableItems: Array<ViewToken<ChatTimelineRow<M>>>;
    }) => {
      latestRef.current.onVisibleRangeChange?.(
        visibleRangeFromTokens(viewableItems)
      );
      const state = listRef.current?.getState?.();
      if (state) reportAtEnd(timelineIsAtEnd(state));
    },
    [reportAtEnd]
  );

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<ChatTimelineRow<M>>) => {
      switch (item.kind) {
        case "day-divider":
          return renderDayDivider(item);
        case "first-unread":
          return renderFirstUnread(item);
        case "group":
          return renderGroup(item);
        case "message":
          return renderMessage(item);
      }
    },
    [renderDayDivider, renderFirstUnread, renderGroup, renderMessage]
  );

  return (
    <LegendList<ChatTimelineRow<M>>
      ref={listRef}
      data={rows}
      extraData={{
        renderDayDivider,
        renderFirstUnread,
        renderGroup,
        renderMessage
      }}
      keyExtractor={(row) => row.key}
      renderItem={renderItem}
      estimatedItemSize={estimatedItemHeight}
      initialScrollAtEnd
      maintainScrollAtEnd
      maintainScrollAtEndThreshold={0.1}
      maintainVisibleContentPosition={{ data: true, size: true }}
      onScroll={handleScroll}
      onStartReached={() => requestPage("older")}
      onStartReachedThreshold={0.25}
      onEndReached={() => requestPage("newer")}
      onEndReachedThreshold={0.25}
      onViewableItemsChanged={handleViewableItemsChanged}
      viewabilityConfig={{ itemVisiblePercentThreshold: 1 }}
      className={className}
      role="list"
      aria-label={ariaLabel}
    />
  );
}

export const ChatTimeline = forwardRef(ChatTimelineInner) as <
  M extends ChatTimelineMessage
>(
  props: ChatTimelineProps<M> & {
    ref?: React.Ref<ChatTimelineHandle>;
  }
) => React.ReactElement;
