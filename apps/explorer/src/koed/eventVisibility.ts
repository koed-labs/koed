import { eventDisplayText } from "./graph";
import type { GraphEvent } from "./types";

export function isTimelineEventVisible(event: GraphEvent): boolean {
  return event.actor === "tool" || eventDisplayText(event).trim().length > 0;
}
