import type { DesktopThreadGroup } from "./project-memory-ui.js";

export type DesktopConversationEvent = {
  id: string;
  actor: string | null;
  eventType: string;
  timestamp: string;
  sourceEventTime: string | null;
  sourceSequence: number | null;
  content?: string;
  contentFull?: string;
  contentPreview: string;
  rawContent?: string;
  invalidatedAt: string | null;
  metadata: Record<string, unknown>;
};

export type ConversationCursor = Pick<
  DesktopConversationEvent,
  "id" | "sourceSequence" | "timestamp"
>;

export type DesktopConversationTimelineItem =
  | {
      kind: "event";
      id: string;
      timestamp: string;
      event: DesktopConversationEvent;
    }
  | {
      kind: "tool-group";
      id: string;
      timestamp: string;
      events: DesktopConversationEvent[];
    };

export function conversationEventText(event: DesktopConversationEvent): string {
  return (
    event.contentFull ??
    event.content ??
    event.rawContent ??
    event.contentPreview ??
    ""
  ).trim();
}

export function compareConversationEvents(
  left: DesktopConversationEvent,
  right: DesktopConversationEvent
): number {
  const time = (left.sourceEventTime ?? left.timestamp).localeCompare(
    right.sourceEventTime ?? right.timestamp
  );
  if (time !== 0) return time;
  if (
    typeof left.sourceSequence === "number" &&
    typeof right.sourceSequence === "number" &&
    left.sourceSequence !== right.sourceSequence
  ) {
    return left.sourceSequence - right.sourceSequence;
  }
  if (typeof left.sourceSequence === "number") return -1;
  if (typeof right.sourceSequence === "number") return 1;
  return left.id.localeCompare(right.id);
}

export function mergeConversationEvents(
  current: DesktopConversationEvent[],
  incoming: DesktopConversationEvent[]
): DesktopConversationEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort(compareConversationEvents);
}

export function groupConversationEvents(
  events: DesktopConversationEvent[]
): DesktopConversationTimelineItem[] {
  const items: DesktopConversationTimelineItem[] = [];
  let toolEvents: DesktopConversationEvent[] = [];
  const flushTools = () => {
    if (toolEvents.length === 1) {
      const event = toolEvents[0]!;
      items.push({
        kind: "event",
        id: event.id,
        timestamp: event.timestamp,
        event
      });
    } else if (toolEvents.length > 1) {
      const first = toolEvents[0]!;
      const last = toolEvents.at(-1)!;
      items.push({
        kind: "tool-group",
        id: `tool-group:${first.id}:${last.id}`,
        timestamp: first.timestamp,
        events: toolEvents
      });
    }
    toolEvents = [];
  };

  for (const event of events) {
    if (event.actor === "tool") {
      toolEvents.push(event);
      continue;
    }
    flushTools();
    items.push({
      kind: "event",
      id: event.id,
      timestamp: event.timestamp,
      event
    });
  }
  flushTools();
  return items;
}

export function conversationEventsUrl({
  apiBaseUrl,
  cursor,
  limit,
  thread
}: {
  apiBaseUrl: string;
  cursor?: ConversationCursor;
  limit: number;
  thread: Pick<DesktopThreadGroup, "id" | "projectId">;
}): string {
  const url = new URL(
    "/v1/memory/graph/events",
    `${apiBaseUrl.replace(/\/$/, "")}/`
  );
  url.searchParams.set("projectId", thread.projectId);
  url.searchParams.set("threadId", thread.id);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("includeContent", "true");
  url.searchParams.set("includeInvalidated", "false");
  if (cursor) {
    url.searchParams.set("cursorTimestamp", cursor.timestamp);
    url.searchParams.set("cursorId", cursor.id);
    if (typeof cursor.sourceSequence === "number") {
      url.searchParams.set(
        "cursorSourceSequence",
        String(cursor.sourceSequence)
      );
    }
  }
  return url.toString();
}
