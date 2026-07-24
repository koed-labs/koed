import { describe, expect, it } from "vitest";
import {
  conversationEventPatch,
  conversationEventText,
  groupConversationEvents,
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
  it("deduplicates pages and restores raw Conversation chronology", () => {
    const latest = [event("b", "2026-07-13T12:00:00.000Z")];
    const merged = mergeConversationEvents(latest, [
      event("a", "2026-07-13T11:00:00.000Z"),
      event("b", "2026-07-13T12:00:00.000Z", { content: "expanded" })
    ]);
    expect(merged.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(conversationEventText(merged[1]!)).toBe("expanded");
  });

  it("groups consecutive tool activity without losing raw Memory Events", () => {
    const events = [
      event("user", "2026-07-13T11:00:00.000Z", { actor: "user" }),
      event("tool-1", "2026-07-13T11:01:00.000Z", { actor: "tool" }),
      event("tool-2", "2026-07-13T11:02:00.000Z", { actor: "tool" }),
      event("agent", "2026-07-13T11:03:00.000Z")
    ];

    const grouped = groupConversationEvents(events);

    expect(grouped.map((item) => item.kind)).toEqual([
      "event",
      "tool-group",
      "event"
    ]);
    expect(grouped[1]).toMatchObject({
      kind: "tool-group",
      events: [{ id: "tool-1" }, { id: "tool-2" }]
    });
  });

  it("recognizes a source diff only when tool identity or content supports it", () => {
    const patch = event("patch", "2026-07-13T11:00:00.000Z", {
      actor: "tool",
      content:
        "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch",
      metadata: { toolName: "apply_patch" }
    });
    expect(conversationEventPatch(patch)).toMatchObject({
      summary: "1 file changed"
    });
    expect(
      conversationEventPatch(
        event("ordinary", "2026-07-13T11:00:00.000Z", {
          content: "Discuss a possible change without a source diff."
        })
      )
    ).toBeNull();
  });
});
