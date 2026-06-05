import {
  LegendList,
  type LegendListRef,
  type LegendListRenderItemProps
} from "@legendapp/list/react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";

import { KoedMessage } from "./components";
import { koedDebug } from "./debug";
import { isTimelineEventVisible } from "./eventVisibility";
import type { GraphEvent } from "./types";

const estimatedEventHeight = 156;

interface EventListExtraData {
  onSelectEvent: (eventId: string) => void;
  selectedEventId: string | null;
}

interface StableEventsState {
  byId: Map<string, GraphEvent>;
  result: GraphEvent[];
}

function isEventRowUnchanged(previous: GraphEvent, next: GraphEvent) {
  return (
    previous === next ||
    (previous.id === next.id &&
      previous.actor === next.actor &&
      previous.eventType === next.eventType &&
      previous.timestamp === next.timestamp &&
      previous.content === next.content &&
      previous.contentFull === next.contentFull &&
      previous.contentPreview === next.contentPreview &&
      previous.rawContent === next.rawContent &&
      previous.invalidatedAt === next.invalidatedAt &&
      previous.invalidationReason === next.invalidationReason &&
      previous.linkedNodeIds.length === next.linkedNodeIds.length &&
      previous.linkedNodeIds.every(
        (id, index) => id === next.linkedNodeIds[index]
      ))
  );
}

function computeStableEvents(
  events: GraphEvent[],
  previous: StableEventsState
): StableEventsState {
  const nextById = new Map<string, GraphEvent>();
  const eventById = new Map<string, GraphEvent>();
  for (const event of events) {
    eventById.set(event.id, event);
  }
  const dedupedEvents = [...eventById.values()]
    .filter(isTimelineEventVisible)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  let changed = dedupedEvents.length !== previous.result.length;

  const result = dedupedEvents.map((event, index) => {
    const previousEvent = previous.byId.get(event.id);
    const nextEvent =
      previousEvent && isEventRowUnchanged(previousEvent, event)
        ? previousEvent
        : event;
    nextById.set(event.id, nextEvent);
    if (!changed && previous.result[index] !== nextEvent) {
      changed = true;
    }
    return nextEvent;
  });

  return changed ? { byId: nextById, result } : previous;
}

function useStableEvents(events: GraphEvent[]) {
  const stateRef = useRef<StableEventsState>({
    byId: new Map(),
    result: []
  });
  return useMemo(() => {
    stateRef.current = computeStableEvents(events, stateRef.current);
    return stateRef.current.result;
  }, [events]);
}

const EventRow = memo(
  function EventRow({
    event,
    isSelected,
    onSelect
  }: {
    event: GraphEvent;
    isSelected: boolean;
    onSelect: (eventId: string) => void;
  }) {
    return (
      <div className="mx-auto w-full max-w-3xl pt-1 pb-5">
        <KoedMessage
          event={event}
          isSelected={isSelected}
          onSelect={() => onSelect(event.id)}
        />
      </div>
    );
  },
  (previous, next) =>
    previous.event === next.event &&
    previous.isSelected === next.isSelected &&
    previous.onSelect === next.onSelect
);

export function VirtualizedEventList({
  events,
  hasOlderEvents,
  onLoadOlder,
  onSelectEvent,
  selectedEventId,
  threadKey
}: {
  events: GraphEvent[];
  hasOlderEvents: boolean;
  onLoadOlder: () => Promise<void> | void;
  onSelectEvent: (eventId: string) => void;
  selectedEventId: string | null;
  threadKey: string;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const stableEvents = useStableEvents(events);
  const olderLoadArmedRef = useRef(true);
  const hasOlderEventsRef = useRef(hasOlderEvents);
  const isPinnedToEndRef = useRef(true);
  const olderLoadInFlightRef = useRef(false);
  const previousEventCountRef = useRef(stableEvents.length);
  const latestRenderedEventIdRef = useRef<string | null>(null);
  const scrollToEndFrameRefs = useRef<number[]>([]);
  const stableEventsRef = useRef(stableEvents);

  const extraData = useMemo<EventListExtraData>(
    () => ({ onSelectEvent, selectedEventId }),
    [onSelectEvent, selectedEventId]
  );

  const renderItem = useCallback(
    ({ extraData, item }: LegendListRenderItemProps<GraphEvent>) => (
      <EventRow
        event={item}
        isSelected={item.id === extraData.selectedEventId}
        onSelect={extraData.onSelectEvent}
      />
    ),
    []
  );

  const listHeader = useMemo(() => <div className="h-4" />, []);
  const listFooter = useMemo(() => <div className="h-4" />, []);

  useEffect(() => {
    stableEventsRef.current = stableEvents;
  }, [stableEvents]);

  const cancelScrollToEndFrames = useCallback(() => {
    for (const frame of scrollToEndFrameRefs.current) {
      window.cancelAnimationFrame(frame);
    }
    scrollToEndFrameRefs.current = [];
  }, []);

  const scrollToEndAfterLayout = useCallback(
    (reason: string) => {
      cancelScrollToEndFrames();
      isPinnedToEndRef.current = true;

      const run = (remainingFrames: number) => {
        const currentEvents = stableEventsRef.current;
        koedDebug("legendList.scrollToEnd", {
          events: currentEvents.length,
          latestEventId: currentEvents.at(-1)?.id ?? null,
          reason,
          remainingFrames
        });
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
    },
    [cancelScrollToEndFrames]
  );

  useEffect(() => {
    olderLoadArmedRef.current = true;
    olderLoadInFlightRef.current = false;
    previousEventCountRef.current = 0;
    latestRenderedEventIdRef.current = null;
    scrollToEndAfterLayout("thread-change");
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
    const latestEvent = stableEvents.at(-1);
    if (
      latestEvent?.id &&
      latestEvent.id !== latestRenderedEventIdRef.current
    ) {
      latestRenderedEventIdRef.current = latestEvent.id;
      koedDebug("legendList.latestEventRendered", {
        events: stableEvents.length,
        latestEventId: latestEvent.id,
        latestTimestamp: latestEvent.timestamp
      });
      if (isPinnedToEndRef.current) {
        const frame = window.requestAnimationFrame(() => {
          koedDebug("legendList.scrollToEndPinned", {
            events: stableEvents.length,
            latestEventId: latestEvent.id
          });
          void listRef.current?.scrollToEnd?.({ animated: false });
        });
        return () => window.cancelAnimationFrame(frame);
      }
    }
  }, [stableEvents]);

  useEffect(() => {
    const previousEventCount = previousEventCountRef.current;
    previousEventCountRef.current = stableEvents.length;

    if (previousEventCount > 0 || stableEvents.length === 0) {
      return;
    }

    koedDebug("legendList.initialScrollToEnd", {
      events: stableEvents.length,
      latestEventId: stableEvents.at(-1)?.id ?? null
    });
    scrollToEndAfterLayout("initial-events");
  }, [scrollToEndAfterLayout, stableEvents]);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (!state) {
      return;
    }
    if (!state.isStartReached) {
      olderLoadArmedRef.current = true;
    }
    isPinnedToEndRef.current = state.isAtEnd;
    koedDebug("legendList.scrollState", {
      isAtEnd: state.isAtEnd,
      isStartReached: state.isStartReached
    });
  }, []);

  const handleStartReached = useCallback(() => {
    if (
      !hasOlderEvents ||
      !olderLoadArmedRef.current ||
      olderLoadInFlightRef.current
    ) {
      koedDebug("legendList.startReachedSkipped", {
        hasOlderEvents,
        armed: olderLoadArmedRef.current,
        inFlight: olderLoadInFlightRef.current
      });
      return;
    }
    olderLoadArmedRef.current = false;
    olderLoadInFlightRef.current = true;
    koedDebug("legendList.startReachedLoadOlder", {
      events: stableEvents.length,
      oldestEventId: stableEvents.at(0)?.id ?? null
    });
    void Promise.resolve(onLoadOlder()).finally(() => {
      olderLoadInFlightRef.current = false;
      window.requestAnimationFrame(() => {
        const state = listRef.current?.getState?.();
        const isScrollable =
          state && state.contentLength > state.scrollLength + 1;
        olderLoadArmedRef.current = Boolean(
          hasOlderEventsRef.current && (!state?.isStartReached || !isScrollable)
        );
        koedDebug("legendList.startReachedRearmed", {
          armed: olderLoadArmedRef.current,
          contentLength: state?.contentLength ?? null,
          hasOlderEvents: hasOlderEventsRef.current,
          isScrollable,
          isStartReached: state?.isStartReached ?? null,
          scrollLength: state?.scrollLength ?? null
        });
      });
    });
  }, [hasOlderEvents, onLoadOlder, stableEvents]);

  return (
    <LegendList<GraphEvent>
      ref={listRef}
      data={stableEvents}
      extraData={extraData}
      keyExtractor={(event) => event.id}
      renderItem={renderItem}
      estimatedItemSize={estimatedEventHeight}
      initialScrollAtEnd
      maintainScrollAtEnd
      maintainScrollAtEndThreshold={0.1}
      maintainVisibleContentPosition
      onScroll={handleScroll}
      onStartReached={handleStartReached}
      onStartReachedThreshold={0.25}
      className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
      ListHeaderComponent={listHeader}
      ListFooterComponent={listFooter}
    />
  );
}
