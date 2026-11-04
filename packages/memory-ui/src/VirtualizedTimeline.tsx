import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps,
  type ViewToken
} from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref
} from "react";

export type VirtualizedTimelineHandle = {
  /**
   * Requests the current older page again after a failed load. Returns false
   * when no older page is available to request.
   */
  retryOlder: () => boolean;
  scrollToEnd: () => void;
};

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

// Fetch before the reader reaches the loaded history's hard scroll boundary.
const olderPrefetchScreens = 1;

export function VirtualizedTimeline<T extends TimelineItem>({
  ariaLabel,
  className,
  controllerRef,
  estimatedItemHeight = 156,
  events,
  hasOlderEvents,
  olderPageKey = events[0]?.id,
  hasNewerEvents = false,
  onAtEndChange,
  onLoadOlder,
  onLoadingOlderChange,
  onLoadNewer,
  onPageLoadError,
  onVisibleRangeChange,
  renderEvent,
  threadKey
}: {
  ariaLabel?: string;
  className?: string;
  controllerRef?: Ref<VirtualizedTimelineHandle>;
  estimatedItemHeight?: number;
  events: T[];
  hasOlderEvents: boolean;
  /** Source-page cursor, when visible rows group or omit source events. */
  olderPageKey?: string;
  hasNewerEvents?: boolean;
  onAtEndChange?: (atEnd: boolean) => void;
  onLoadOlder: () => Promise<void> | void;
  onLoadingOlderChange?: (loading: boolean) => void;
  onLoadNewer?: () => Promise<void> | void;
  onPageLoadError?: (error: unknown, direction: "newer" | "older") => void;
  onVisibleRangeChange?: (range: TimelineVisibleRange<T> | null) => void;
  renderEvent: (event: T) => ReactNode;
  threadKey: string;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const olderRequestedBoundaryRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const isPinnedToEndRef = useRef(true);
  const olderLoadInFlightRef = useRef(false);
  const newerLoadInFlightRef = useRef(false);
  const previousEventCountRef = useRef(events.length);
  const latestRenderedEventIdRef = useRef<string | null>(null);
  const scrollToEndFrameRefs = useRef<number[]>([]);
  const lastReportedAtEndRef = useRef<boolean | null>(null);
  const callbackRef = useRef({
    onAtEndChange,
    onLoadingOlderChange,
    onVisibleRangeChange
  });
  callbackRef.current = {
    onAtEndChange,
    onLoadingOlderChange,
    onVisibleRangeChange
  };
  const olderPageRef = useRef({
    hasOlderEvents,
    boundary: olderPageKey,
    onLoadOlder,
    onPageLoadError
  });
  olderPageRef.current = {
    hasOlderEvents,
    boundary: olderPageKey,
    onLoadOlder,
    onPageLoadError
  };

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
    olderRequestedBoundaryRef.current = null;
    loadGenerationRef.current += 1;
    olderLoadInFlightRef.current = false;
    setLoadingOlder(false);
    newerLoadInFlightRef.current = false;
    previousEventCountRef.current = 0;
    latestRenderedEventIdRef.current = null;
    lastReportedAtEndRef.current = null;
    callbackRef.current.onVisibleRangeChange?.(null);
    scrollToEndAfterLayout();
    return () => {
      loadGenerationRef.current += 1;
      cancelScrollToEndFrames();
    };
  }, [cancelScrollToEndFrames, scrollToEndAfterLayout, threadKey]);

  useEffect(() => {
    callbackRef.current.onLoadingOlderChange?.(loadingOlder);
  }, [loadingOlder]);

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
    const { hasOlderEvents, boundary, onLoadOlder, onPageLoadError } =
      olderPageRef.current;
    if (
      !hasOlderEvents ||
      !boundary ||
      olderRequestedBoundaryRef.current === boundary ||
      olderLoadInFlightRef.current
    ) {
      return;
    }
    olderRequestedBoundaryRef.current = boundary;
    olderLoadInFlightRef.current = true;
    setLoadingOlder(true);
    const generation = loadGenerationRef.current;
    void Promise.resolve()
      .then(() => {
        if (generation === loadGenerationRef.current) return onLoadOlder();
      })
      .catch((error: unknown) => {
        if (generation === loadGenerationRef.current)
          onPageLoadError?.(error, "older");
      })
      .finally(() => {
        if (generation !== loadGenerationRef.current) return;
        olderLoadInFlightRef.current = false;
        setLoadingOlder(false);
      });
  }, []);

  // A failed boundary stays blocked so failures never loop on their own. A
  // short timeline cannot scroll out of the prefetch zone to clear it, so the
  // owner retries explicitly.
  const retryOlder = useCallback(() => {
    const { hasOlderEvents, boundary } = olderPageRef.current;
    if (!hasOlderEvents || !boundary) return false;
    if (!olderLoadInFlightRef.current) {
      olderRequestedBoundaryRef.current = null;
      handleStartReached();
    }
    return true;
  }, [handleStartReached]);

  useImperativeHandle(
    controllerRef,
    () => ({ retryOlder, scrollToEnd: scrollToEndAfterLayout }),
    [retryOlder, scrollToEndAfterLayout]
  );

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (!state) return;
    const nearStart = state.scroll <= state.scrollLength * olderPrefetchScreens;
    if (!nearStart) olderRequestedBoundaryRef.current = null;
    else handleStartReached();
    isPinnedToEndRef.current = state.isAtEnd;
    reportAtEnd(state.isAtEnd);
  }, [handleStartReached, reportAtEnd]);

  useEffect(() => {
    if (loadingOlder || !hasOlderEvents) return;
    const state = listRef.current?.getState?.();
    // A prepend can finish inside the prefetch zone without another threshold
    // crossing. Continue only for a new boundary; an empty/failed page must not loop.
    if (
      state &&
      state.scroll <= state.scrollLength * olderPrefetchScreens &&
      (!state.isAtEnd || state.contentLength <= state.scrollLength + 1)
    )
      handleStartReached();
  }, [olderPageKey, hasOlderEvents, loadingOlder, handleStartReached]);

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
      onStartReachedThreshold={olderPrefetchScreens}
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
