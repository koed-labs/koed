import { describe, expect, it } from "vitest";
import {
  conversationEventText,
  conversationEventsUrl,
  mergeConversationEvents,
  type DesktopConversationEvent
} from "./desktop-conversation.js";

const event = (
  id: string,
  timestamp: string,
  overrides: Partial<DesktopConversationEvent> = {}
): DesktopConversationEvent => ({
  id,
  actor: "assistant",
  eventType: "message",
  timestamp,
  sourceEventTime: null,
  sourceSequence: null,
  contentPreview: id,
  invalidatedAt: null,
  metadata: {},
  ...overrides
});

describe("native Desktop conversation contract", () => {
  it("requests the selected Project/thread directly without iframe state", () => {
    const url = new URL(
      conversationEventsUrl({
        apiBaseUrl: "http://127.0.0.1:4170",
        limit: 50,
        thread: { id: "thread:1", projectId: "/Users/jedd/agents/koed" }
      })
    );
    expect(url.pathname).toBe("/v1/memory/graph/events");
    expect(url.searchParams.get("projectId")).toBe("/Users/jedd/agents/koed");
    expect(url.searchParams.get("threadId")).toBe("thread:1");
    expect(url.searchParams.get("includeContent")).toBe("true");
  });

  it("adds a stable cursor when older Memory Events are requested", () => {
    const url = new URL(
      conversationEventsUrl({
        apiBaseUrl: "http://localhost:4170/",
        cursor: {
          id: "11111111-1111-4111-8111-111111111111",
          sourceSequence: 7,
          timestamp: "2026-07-13T12:00:00.000Z"
        },
        limit: 500,
        thread: { id: "thread-1", projectId: "project-1" }
      })
    );
    expect(url.searchParams.get("cursorSourceSequence")).toBe("7");
    expect(url.searchParams.get("cursorTimestamp")).toBe(
      "2026-07-13T12:00:00.000Z"
    );
  });

  it("deduplicates pages and restores raw Conversation chronology", () => {
    const latest = [event("b", "2026-07-13T12:00:00.000Z")];
    const merged = mergeConversationEvents(latest, [
      event("a", "2026-07-13T11:00:00.000Z"),
      event("b", "2026-07-13T12:00:00.000Z", { content: "expanded" })
    ]);
    expect(merged.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(conversationEventText(merged[1]!)).toBe("expanded");
  });
});
