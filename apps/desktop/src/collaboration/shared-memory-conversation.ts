import type { SharedMemorySourceItem } from "@koed/shared/collaboration";

import type { DesktopConversationEvent } from "../desktop-conversation.js";

const actorForSourceKind = (
  sourceKind:
    | "user_message"
    | "agent_message"
    | "thought"
    | "tool_call"
    | "tool_result"
): DesktopConversationEvent["actor"] =>
  sourceKind === "user_message"
    ? "user"
    : sourceKind === "tool_call" || sourceKind === "tool_result"
      ? "tool"
      : "assistant";

export const sharedMemoryConversationEvents = (
  items: readonly SharedMemorySourceItem[]
): DesktopConversationEvent[] =>
  items.flatMap((item) =>
    item.representation === "memory_events"
      ? item.sourceItems.map((source) => ({
          id: source.id,
          actor: actorForSourceKind(source.sourceKind),
          eventType: source.sourceKind,
          timestamp: source.occurredAt,
          sourceEventTime: source.occurredAt,
          sourceSequence: item.sequence,
          content: source.body,
          contentPreview: source.body.slice(0, 16_384),
          invalidatedAt: null,
          ...(source.approvalDecisionDisplay
            ? { approvalDecisionDisplay: source.approvalDecisionDisplay }
            : {}),
          ...(source.toolDisplay ? { toolDisplay: source.toolDisplay } : {}),
          metadata: source.toolName ? { toolName: source.toolName } : {}
        }))
      : []
  );
