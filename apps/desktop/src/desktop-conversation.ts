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
  return (event.content ?? event.contentPreview ?? "").trim();
}

export type ConversationEventPatch = {
  sourceText: string;
  summary: string;
};

const patchFilePattern =
  /^(?:\*{3} (?:Add|Delete|Update) File: [^\n]+|diff --git [^\n]+)$/gmu;

export function conversationEventPatch(
  event: DesktopConversationEvent
): ConversationEventPatch | null {
  const toolName =
    typeof event.metadata.toolName === "string"
      ? event.metadata.toolName.toLocaleLowerCase()
      : "";
  const sourceText = conversationEventText(event);
  const patchLike =
    toolName.includes("patch") ||
    sourceText.includes("*** Begin Patch") ||
    /^diff --git /mu.test(sourceText);
  if (!patchLike || !sourceText) return null;
  const fileCount = new Set(sourceText.match(patchFilePattern) ?? []).size;
  return {
    sourceText,
    summary: fileCount
      ? `${fileCount} ${fileCount === 1 ? "file" : "files"} changed`
      : "Source diff"
  };
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
