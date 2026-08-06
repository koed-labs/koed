import type { SharedMemorySourceItem } from "@koed/shared/collaboration";
import { describe, expect, it } from "vitest";

import { sharedMemoryConversationEvents } from "./shared-memory-conversation.js";

const id = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const occurredAt = "2026-08-06T12:00:00.000Z";

describe("sharedMemoryConversationEvents", () => {
  it("adapts Shared Memory source parts to the Personal conversation contract", () => {
    const items: SharedMemorySourceItem[] = [
      {
        id: id(1),
        representation: "memory_events",
        sequence: 7,
        occurredAt,
        sourceItems: [
          {
            id: id(2),
            sourceKind: "user_message",
            occurredAt,
            body: "Please inspect the patch.",
            actorName: null,
            toolName: null,
            toolCallId: null
          },
          {
            id: id(3),
            sourceKind: "tool_call",
            occurredAt,
            body: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch",
            actorName: null,
            toolName: "apply_patch",
            toolCallId: "call-1",
            toolDisplay: {
              kind: "file_change",
              label: "Changed files",
              preview: "Update src/app.ts",
              toolName: "apply_patch",
              callId: "call-1",
              patchSource:
                "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch"
            }
          }
        ]
      }
    ];

    expect(sharedMemoryConversationEvents(items)).toEqual([
      expect.objectContaining({
        id: id(2),
        actor: "user",
        eventType: "user_message",
        content: "Please inspect the patch.",
        sourceSequence: 7
      }),
      expect.objectContaining({
        id: id(3),
        actor: "tool",
        eventType: "tool_call",
        metadata: { toolName: "apply_patch" },
        toolDisplay: expect.objectContaining({ kind: "file_change" })
      })
    ]);
  });

  it("preserves the bounded auto-approval projection", () => {
    const event = sharedMemoryConversationEvents([
      {
        id: id(4),
        representation: "memory_events",
        sequence: 8,
        occurredAt,
        sourceItems: [
          {
            id: id(5),
            sourceKind: "agent_message",
            occurredAt,
            body: "redacted source body",
            actorName: null,
            toolName: null,
            toolCallId: null,
            approvalDecisionDisplay: {
              kind: "auto_approval",
              version: 1,
              riskLevel: "low",
              userAuthorization: "medium",
              outcome: "allow",
              rationale: "The action is within the requested scope."
            }
          }
        ]
      }
    ])[0];

    expect(event).toMatchObject({
      actor: "assistant",
      approvalDecisionDisplay: {
        outcome: "allow",
        riskLevel: "low",
        userAuthorization: "medium"
      }
    });
  });
});
