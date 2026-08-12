import {
  conversationToolKindAndLabel,
  type PersonalDesktopConversationEvent
} from "@koed/shared/personal-desktop";
import { parseSourcePatch, type SourcePatchDetails } from "@koed/memory-ui";

export type DesktopConversationEvent = PersonalDesktopConversationEvent;

export type DesktopToolDisplay = NonNullable<
  DesktopConversationEvent["toolDisplay"]
>;

export type ConversationCursor = Pick<
  DesktopConversationEvent,
  "id" | "sourceSequence" | "timestamp"
>;

const approvalReviewDisplayIdMarker = ":approval-display:";

export function approvalReviewSourceEventId(eventId: string): string | null {
  const marker = eventId.indexOf(approvalReviewDisplayIdMarker);
  return marker > 0 ? eventId.slice(0, marker) : null;
}

export function expandConversationDisplayEvents(
  events: readonly DesktopConversationEvent[]
): DesktopConversationEvent[] {
  return events.flatMap((event) => {
    const display = event.transcriptDisplay;
    if (!display) return [event];
    return display.segments.map((segment, index) => ({
      id: `${event.id}${approvalReviewDisplayIdMarker}${segment.sequence}:${index}`,
      actor: segment.kind === "message" ? segment.actor : "tool",
      eventType: `codex_transcript_${segment.kind}`,
      timestamp: event.timestamp,
      sourceEventTime: event.sourceEventTime,
      sourceSequence: segment.sequence,
      content: segment.content,
      contentPreview: segment.content.slice(0, 16_384),
      invalidatedAt: event.invalidatedAt,
      metadata: segment.kind === "message" ? {} : { toolName: segment.toolName }
    }));
  });
}

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

export function conversationEventToolDisplay(
  event: DesktopConversationEvent
): DesktopToolDisplay {
  if (event.toolDisplay) return event.toolDisplay;
  const toolName = event.metadata.toolName;
  const name = typeof toolName === "string" ? toolName : "";
  const classification = conversationToolKindAndLabel(name);
  return {
    ...classification,
    preview:
      conversationEventText(event).split(/\r?\n/u)[0] || "No preview available",
    ...(name ? { toolName: name } : {})
  };
}

const activityLabel = (
  kind: DesktopToolDisplay["kind"],
  count: number
): string => {
  const labels: Record<DesktopToolDisplay["kind"], [string, string]> = {
    command: ["command", "commands"],
    file_change: ["file change", "file changes"],
    file_read: ["file read", "file reads"],
    search: ["search", "searches"],
    tool: ["other tool", "other tools"]
  };
  return `${count} ${labels[kind][count === 1 ? 0 : 1]}`;
};

export function summarizeToolActivity(
  events: readonly DesktopConversationEvent[]
): string {
  const order: DesktopToolDisplay["kind"][] = [
    "command",
    "file_change",
    "file_read",
    "search",
    "tool"
  ];
  const counts = new Map<DesktopToolDisplay["kind"], number>();
  for (const event of events) {
    const kind = conversationEventToolDisplay(event).kind;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return order
    .flatMap((kind) => {
      const count = counts.get(kind) ?? 0;
      return count ? [activityLabel(kind, count)] : [];
    })
    .join(" · ");
}

export type ConversationEventPatch = SourcePatchDetails;

export function conversationEventPatch(
  event: DesktopConversationEvent
): ConversationEventPatch | null {
  const display = conversationEventToolDisplay(event);
  const sourceText = display.patchSource ?? conversationEventText(event);
  if (display.kind !== "file_change" && !display.patchSource) return null;
  return parseSourcePatch(sourceText);
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
