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

/** Show completed native Agent replies in Home's existing Ongoing section. */
export function nativeRecentActivityInOngoing(
  ongoing: readonly HomeItem[],
  recent: readonly HomeItem[]
): HomeItem[] {
  const grouped = new Map<
    string,
    { item: HomeItem; bucket: "ongoing" | "recent" }
  >();
  const ungrouped: HomeItem[] = [];
  const candidates = [
    ...ongoing.map((item) => ({ item, bucket: "ongoing" as const })),
    ...recent
      .filter((item) => item.source === "native_agent_activity")
      .map((item) => ({ item, bucket: "recent" as const }))
  ];

  for (const candidate of candidates) {
    const executionId =
      candidate.item.destination.kind === "execution"
        ? candidate.item.destination.executionId
        : null;
    if (!executionId) {
      if (
        candidate.bucket === "ongoing" ||
        !ungrouped.some(
          (item) => item.sourceEventId === candidate.item.sourceEventId
        )
      ) {
        ungrouped.push(candidate.item);
      }
      continue;
    }

    const current = grouped.get(executionId);
    if (!current) {
      grouped.set(executionId, candidate);
      continue;
    }
    if (current.bucket !== candidate.bucket) {
      if (candidate.bucket === "ongoing") grouped.set(executionId, candidate);
      continue;
    }
    if (
      candidate.item.source === "native_agent_activity" &&
      current.item.source !== "native_agent_activity"
    ) {
      grouped.set(executionId, candidate);
      continue;
    }
    if (
      candidate.item.source === "native_agent_activity" &&
      current.item.source === "native_agent_activity" &&
      Date.parse(candidate.item.updatedAt) > Date.parse(current.item.updatedAt)
    ) {
      grouped.set(executionId, candidate);
    }
  }

  return [...ungrouped, ...[...grouped.values()].map(({ item }) => item)];
}

/** Collapse child execution activity into one openable logical-chat row. */
export function rootPersonalConversationOngoingItems(
  snapshot: HomeSnapshot | null,
  conversations: readonly PersonalAgentChatConversationSummary[]
): HomeSnapshot | null {
  if (!snapshot) return null;
  if (conversations.length === 0) {
    return {
      ...snapshot,
      ongoing: nativeRecentActivityInOngoing(snapshot.ongoing, snapshot.recent)
    };
  }
  const roots = new Map<string, HomeItem>();
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
    const current = roots.get(root.conversationId);
    // Native activity already carries the safe Agent/provider attribution and
    // status selected by the producer. Prefer it over a legacy child execution
    // row when both point to the same root, while retaining the newest native
    // row when several recipients are active in sequence.
    if (current && current.source === "native_agent_activity") {
      if (
        item.source === "native_agent_activity" &&
        Date.parse(item.updatedAt) > Date.parse(current.updatedAt)
      ) {
        roots.set(root.conversationId, {
          ...item,
          destination: {
            kind: "execution",
            executionId: root.conversationId
          }
        });
      }
      continue;
    }
    if (item.source === "native_agent_activity") {
      roots.set(root.conversationId, {
        ...item,
        destination: {
          kind: "execution",
          executionId: root.conversationId
        }
      });
      continue;
    }
    if (current) continue;
    roots.set(root.conversationId, {
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
  return {
    ...snapshot,
    ongoing: nativeRecentActivityInOngoing(
      [...ongoing, ...roots.values()],
      snapshot.recent
    )
  };
}
