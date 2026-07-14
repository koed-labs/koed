import { VirtualizedTimeline } from "@koed/memory-ui";
import { memo, useCallback, useMemo, useRef } from "react";

import { KoedMessage } from "./components";
import { isTimelineEventVisible } from "./eventVisibility";
import type { GraphEvent } from "./types";

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
  for (const event of events) eventById.set(event.id, event);
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
    if (!changed && previous.result[index] !== nextEvent) changed = true;
    return nextEvent;
  });
  return changed ? { byId: nextById, result } : previous;
}

function useStableEvents(events: GraphEvent[]) {
  const stateRef = useRef<StableEventsState>({ byId: new Map(), result: [] });
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
  const stableEvents = useStableEvents(events);
  const renderEvent = useCallback(
    (event: GraphEvent) => (
      <EventRow
        event={event}
        isSelected={event.id === selectedEventId}
        onSelect={onSelectEvent}
      />
    ),
    [onSelectEvent, selectedEventId]
  );

  return (
    <VirtualizedTimeline
      className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
      events={stableEvents}
      hasOlderEvents={hasOlderEvents}
      onLoadOlder={onLoadOlder}
      renderEvent={renderEvent}
      threadKey={threadKey}
    />
  );
}
