import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
  type ViewToken
} from "@legendapp/list/react";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";

export type TimelineItem = {
  id: string;
  timestamp?: string;
};

export type TimelineVisibleRange<T extends TimelineItem> = {
  endIndex: number;
  endItem: T;
  startIndex: number;
  startItem: T;
  visibleItems: readonly T[];
};

export function VirtualizedTimeline<T extends TimelineItem>({
  ariaLabel,
  className,
  estimatedItemHeight = 156,
  events,
  hasOlderEvents,
  hasNewerEvents = false,
  onAtEndChange,
  onLoadOlder,
  onLoadNewer,
  onPageLoadError,
  onVisibleRangeChange,
  renderEvent,
  threadKey
}: {
  ariaLabel?: string;
  className?: string;
  estimatedItemHeight?: number;
  events: T[];
  hasOlderEvents: boolean;
  hasNewerEvents?: boolean;
  onAtEndChange?: (atEnd: boolean) => void;
  onLoadOlder: () => Promise<void> | void;
  onLoadNewer?: () => Promise<void> | void;
  onPageLoadError?: (error: unknown, direction: "newer" | "older") => void;
  onVisibleRangeChange?: (range: TimelineVisibleRange<T> | null) => void;
  renderEvent: (event: T) => ReactNode;
  threadKey: string;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const olderLoadArmedRef = useRef(true);
  const hasOlderEventsRef = useRef(hasOlderEvents);
  const isPinnedToEndRef = useRef(true);
  const olderLoadInFlightRef = useRef(false);
  const newerLoadInFlightRef = useRef(false);
  const previousEventCountRef = useRef(events.length);
  const latestRenderedEventIdRef = useRef<string | null>(null);
  const scrollToEndFrameRefs = useRef<number[]>([]);
  const lastReportedAtEndRef = useRef<boolean | null>(null);
  const callbackRef = useRef({
    onAtEndChange,
    onVisibleRangeChange
  });
  callbackRef.current = { onAtEndChange, onVisibleRangeChange };

  const reportAtEnd = useCallback((atEnd: boolean) => {
    if (lastReportedAtEndRef.current === atEnd) return;
    lastReportedAtEndRef.current = atEnd;
    callbackRef.current.onAtEndChange?.(atEnd);
  }, []);

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<T>) => renderEvent(item),
    [renderEvent]
  );
  const listHeader = useMemo(
    () => <div aria-hidden="true" style={{ height: 16 }} />,
    []
  );
  const listFooter = useMemo(
    () => <div aria-hidden="true" style={{ height: 16 }} />,
    []
  );

  const cancelScrollToEndFrames = useCallback(() => {
    for (const frame of scrollToEndFrameRefs.current) {
      window.cancelAnimationFrame(frame);
    }
    scrollToEndFrameRefs.current = [];
  }, []);

  const scrollToEndAfterLayout = useCallback(() => {
    cancelScrollToEndFrames();
    isPinnedToEndRef.current = true;
    const run = (remainingFrames: number) => {
      void listRef.current?.scrollToEnd?.({ animated: false });
      if (remainingFrames <= 0) {
        scrollToEndFrameRefs.current = [];
        return;
      }
      const frame = window.requestAnimationFrame(() =>
        run(remainingFrames - 1)
      );
      scrollToEndFrameRefs.current.push(frame);
    };
    const frame = window.requestAnimationFrame(() => run(2));
    scrollToEndFrameRefs.current = [frame];
  }, [cancelScrollToEndFrames]);

  useEffect(() => {
    olderLoadArmedRef.current = true;
    olderLoadInFlightRef.current = false;
    newerLoadInFlightRef.current = false;
    previousEventCountRef.current = 0;
    latestRenderedEventIdRef.current = null;
    lastReportedAtEndRef.current = null;
    callbackRef.current.onVisibleRangeChange?.(null);
    scrollToEndAfterLayout();
    return cancelScrollToEndFrames;
  }, [cancelScrollToEndFrames, scrollToEndAfterLayout, threadKey]);

  useEffect(() => {
    hasOlderEventsRef.current = hasOlderEvents;
    if (!hasOlderEvents) {
      olderLoadArmedRef.current = false;
    } else if (!olderLoadInFlightRef.current) {
      olderLoadArmedRef.current = true;
    }
  }, [hasOlderEvents]);

  useEffect(() => {
    const latestEvent = events.at(-1);
    if (
      latestEvent?.id &&
      latestEvent.id !== latestRenderedEventIdRef.current
    ) {
      latestRenderedEventIdRef.current = latestEvent.id;
      if (isPinnedToEndRef.current) {
        const frame = window.requestAnimationFrame(() => {
          void listRef.current?.scrollToEnd?.({ animated: false });
        });
        return () => window.cancelAnimationFrame(frame);
      }
    }
  }, [events]);

  useEffect(() => {
    const previousEventCount = previousEventCountRef.current;
    previousEventCountRef.current = events.length;
    if (previousEventCount === 0 && events.length > 0) {
      scrollToEndAfterLayout();
    }
  }, [events, scrollToEndAfterLayout]);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (!state) return;
    if (!state.isStartReached) olderLoadArmedRef.current = true;
    isPinnedToEndRef.current = state.isAtEnd;
    reportAtEnd(state.isAtEnd);
  }, [reportAtEnd]);

  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: Array<ViewToken<T>> }) => {
      const visible = viewableItems
        .filter((token) => token.isViewable && token.index >= 0)
        .sort((left, right) => left.index - right.index);
      const first = visible[0];
      const last = visible.at(-1);
      callbackRef.current.onVisibleRangeChange?.(
        first && last
          ? {
              endIndex: last.index,
              endItem: last.item,
              startIndex: first.index,
              startItem: first.item,
              visibleItems: visible.map((token) => token.item)
            }
          : null
      );
    },
    []
  );

  const handleStartReached = useCallback(() => {
    if (
      !hasOlderEvents ||
      !olderLoadArmedRef.current ||
      olderLoadInFlightRef.current
    ) {
      return;
    }
    olderLoadArmedRef.current = false;
    olderLoadInFlightRef.current = true;
    void Promise.resolve()
      .then(() => onLoadOlder())
      .catch((error: unknown) => onPageLoadError?.(error, "older"))
      .finally(() => {
        olderLoadInFlightRef.current = false;
        window.requestAnimationFrame(() => {
          const state = listRef.current?.getState?.();
          const isScrollable =
            state && state.contentLength > state.scrollLength + 1;
          olderLoadArmedRef.current = Boolean(
            hasOlderEventsRef.current &&
            (!state?.isStartReached || !isScrollable)
          );
        });
      });
  }, [hasOlderEvents, onLoadOlder, onPageLoadError]);

  const handleEndReached = useCallback(() => {
    if (!hasNewerEvents || !onLoadNewer || newerLoadInFlightRef.current) {
      return;
    }
    newerLoadInFlightRef.current = true;
    void Promise.resolve()
      .then(() => onLoadNewer())
      .catch((error: unknown) => onPageLoadError?.(error, "newer"))
      .finally(() => {
        newerLoadInFlightRef.current = false;
      });
  }, [hasNewerEvents, onLoadNewer, onPageLoadError]);

  return (
    <LegendList<T>
      ref={listRef}
      data={events}
      extraData={renderEvent}
      keyExtractor={(event) => event.id}
      renderItem={renderItem}
      estimatedItemSize={estimatedItemHeight}
      initialScrollAtEnd
      maintainScrollAtEnd
      maintainScrollAtEndThreshold={0.1}
      maintainVisibleContentPosition={{ data: true, size: true }}
      onScroll={handleScroll}
      onStartReached={handleStartReached}
      onStartReachedThreshold={0.25}
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.25}
      onViewableItemsChanged={handleViewableItemsChanged}
      viewabilityConfig={{ itemVisiblePercentThreshold: 1 }}
      className={className}
      role="list"
      aria-label={ariaLabel}
      ListHeaderComponent={listHeader}
      ListFooterComponent={listFooter}
    />
  );
}
