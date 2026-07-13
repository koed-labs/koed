import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps
} from "@legendapp/list/react";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";

export type TimelineItem = {
  id: string;
  timestamp: string;
};

export function VirtualizedTimeline<T extends TimelineItem>({
  className,
  estimatedItemHeight = 156,
  events,
  hasOlderEvents,
  onLoadOlder,
  renderEvent,
  threadKey
}: {
  className?: string;
  estimatedItemHeight?: number;
  events: T[];
  hasOlderEvents: boolean;
  onLoadOlder: () => Promise<void> | void;
  renderEvent: (event: T) => ReactNode;
  threadKey: string;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const olderLoadArmedRef = useRef(true);
  const hasOlderEventsRef = useRef(hasOlderEvents);
  const isPinnedToEndRef = useRef(true);
  const olderLoadInFlightRef = useRef(false);
  const previousEventCountRef = useRef(events.length);
  const latestRenderedEventIdRef = useRef<string | null>(null);
  const scrollToEndFrameRefs = useRef<number[]>([]);

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
    previousEventCountRef.current = 0;
    latestRenderedEventIdRef.current = null;
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
  }, []);

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
    void Promise.resolve(onLoadOlder()).finally(() => {
      olderLoadInFlightRef.current = false;
      window.requestAnimationFrame(() => {
        const state = listRef.current?.getState?.();
        const isScrollable =
          state && state.contentLength > state.scrollLength + 1;
        olderLoadArmedRef.current = Boolean(
          hasOlderEventsRef.current && (!state?.isStartReached || !isScrollable)
        );
      });
    });
  }, [hasOlderEvents, onLoadOlder]);

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
      maintainVisibleContentPosition
      onScroll={handleScroll}
      onStartReached={handleStartReached}
      onStartReachedThreshold={0.25}
      className={className}
      ListHeaderComponent={listHeader}
      ListFooterComponent={listFooter}
    />
  );
}
