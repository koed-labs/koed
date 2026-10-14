import type { PersonalAgentChatConversationSummary } from "@koed/shared/personal-agent-chat-contract";
import type { HomeItem, HomeSnapshot } from "@koed/shared/home";

/** Resolve a legacy source or child execution link to its durable chat root. */
export function personalConversationForExecution(
  conversations: readonly PersonalAgentChatConversationSummary[],
  executionId: string | null | undefined
): PersonalAgentChatConversationSummary | undefined {
  if (!executionId) return undefined;
  return conversations.find(
    (conversation) =>
      conversation.conversationId === executionId ||
      conversation.sourceExecutionIds.includes(executionId) ||
      conversation.childExecutionIds.includes(executionId) ||
      conversation.capturedSessionIds.includes(executionId)
  );
}

/** Collapse child execution activity into one openable logical-chat row. */
export function rootPersonalConversationOngoingItems(
  snapshot: HomeSnapshot | null,
  conversations: readonly PersonalAgentChatConversationSummary[]
): HomeSnapshot | null {
  if (!snapshot || conversations.length === 0) return snapshot;
  const seenRoots = new Set<string>();
  const ongoing: HomeItem[] = [];
  for (const item of snapshot.ongoing) {
    const executionId =
      item.destination.kind === "execution"
        ? item.destination.executionId
        : null;
    const root = personalConversationForExecution(conversations, executionId);
    if (!root) {
      ongoing.push(item);
      continue;
    }
    if (seenRoots.has(root.conversationId)) continue;
    seenRoots.add(root.conversationId);
    ongoing.push({
      ...item,
      title:
        root.title?.trim() ||
        (root.latestAgentName
          ? `Chat with ${root.latestAgentName}`
          : "Personal chat"),
      summary: "Agent work is continuing in this chat.",
      destination: {
        kind: "execution",
        executionId: root.conversationId
      }
    });
  }
  return { ...snapshot, ongoing };
}
