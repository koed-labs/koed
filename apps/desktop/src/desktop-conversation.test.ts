import { describe, expect, it } from "vitest";
import {
  approvalReviewSourceEventId,
  conversationEventPatch,
  conversationEventText,
  conversationEventToolDisplay,
  expandConversationDisplayEvents,
  groupConversationEvents,
  mergeConversationEvents,
  summarizeToolActivity,
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

  it("expands approval-review fallback data into the standard timeline shape", () => {
    const transcriptDisplay: NonNullable<
      DesktopConversationEvent["transcriptDisplay"]
    > = {
      kind: "approval_review",
      version: 1,
      truncated: false,
      segments: [
        { kind: "message", sequence: 1, actor: "user", content: "Request" },
        {
          kind: "tool_call",
          sequence: 2,
          toolName: "exec",
          content: "pnpm test"
        },
        {
          kind: "tool_result",
          sequence: 3,
          toolName: "exec",
          content: "Tests passed"
        }
      ]
    };
    const source = event("approval", "2026-07-13T11:00:00.000Z", {
      actor: "user",
      activityDisplay: {
        kind: "approval_review",
        label: "Approval activity",
        transcript: transcriptDisplay
      },
      transcriptDisplay
    });

    const expanded = expandConversationDisplayEvents([source]);

    expect(expanded.map(({ actor }) => actor)).toEqual([
      "user",
      "tool",
      "tool"
    ]);
    expect(groupConversationEvents(expanded).map(({ kind }) => kind)).toEqual([
      "event",
      "tool-group"
    ]);
    expect(expanded.every(({ activityDisplay }) => !activityDisplay)).toBe(
      true
    );
    expect(approvalReviewSourceEventId(expanded[0]!.id)).toBe(source.id);
  });

  it("prefers canonical messages and omits internal approval activity", () => {
    const canonical = event("canonical", "2026-07-13T10:59:00.000Z", {
      actor: "user",
      content: "Original request"
    });
    const transcript = event("approval", "2026-07-13T11:00:00.000Z", {
      actor: null,
      eventType: "approval_activity",
      transcriptDisplay: {
        kind: "approval_review",
        version: 1,
        truncated: false,
        segments: [
          {
            kind: "message",
            sequence: 1,
            actor: "user",
            content: "Original request"
          }
        ]
      }
    });
    const helper = event("helper", "2026-07-13T11:01:00.000Z", {
      actor: null,
      eventType: "approval_activity",
      activityDisplay: {
        kind: "approval_status",
        label: "Approval activity",
        status: "helper_conversation"
      }
    });

    expect(
      expandConversationDisplayEvents([canonical, transcript, helper]).map(
        ({ id }) => id
      )
    ).toEqual([canonical.id]);
  });

  it("uses display-safe semantic tool summaries and categorizes a group", () => {
    const tools = [
      event("command", "2026-07-13T11:00:00.000Z", {
        actor: "tool",
        toolDisplay: {
          kind: "command",
          label: "Ran command",
          preview: "pnpm test",
          toolName: "exec_command"
        }
      }),
      event("patch", "2026-07-13T11:01:00.000Z", {
        actor: "tool",
        toolDisplay: {
          kind: "file_change",
          label: "Changed files",
          preview: "src/app.ts",
          toolName: "apply_patch"
        }
      }),
      event("search", "2026-07-13T11:02:00.000Z", {
        actor: "tool",
        toolDisplay: {
          kind: "search",
          label: "Searched files",
          preview: "SecureMarkdown",
          toolName: "rg"
        }
      })
    ];

    expect(conversationEventToolDisplay(tools[0]!)).toMatchObject({
      label: "Ran command",
      preview: "pnpm test"
    });
    expect(summarizeToolActivity(tools)).toBe(
      "1 command · 1 file change · 1 search"
    );
  });

  it("classifies write_stdin as terminal activity in renderer fallback", () => {
    expect(
      conversationEventToolDisplay(
        event("stdin", "2026-07-13T11:00:00.000Z", {
          actor: "tool",
          metadata: { toolName: "write_stdin" }
        })
      )
    ).toMatchObject({ kind: "command", label: "Ran command" });
  });

  it("recognizes a source diff only when tool identity or content supports it", () => {
    const patch = event("patch", "2026-07-13T11:00:00.000Z", {
      actor: "tool",
      content:
        "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch",
      metadata: { toolName: "apply_patch" }
    });
    expect(conversationEventPatch(patch)).toMatchObject({
      summary: expect.stringContaining("1 file changed"),
      files: [
        expect.objectContaining({
          displayName: "app.ts",
          additions: 1,
          deletions: 1
        })
      ]
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
