import type {
  ManagedConversationRuntimeItem,
  ManagedConversationTurnCitation
} from "../../../ipc/managed-conversation-protocol.js";

/** A row may cite only the latest observed provider turn in this execution. */
export function latestRuntimeTurn(
  items: readonly ManagedConversationRuntimeItem[],
  itemId?: string,
  executionGeneration?: number
): string | null {
  const currentGeneration =
    executionGeneration ??
    Math.max(0, ...items.map((item) => item.executionGeneration));
  if (itemId)
    return (
      items.find(
        (item) =>
          item.id === itemId && item.executionGeneration === currentGeneration
      )?.providerTurnId ?? null
    );
  const latest = items
    .filter(
      (item) =>
        item.executionGeneration === currentGeneration && item.providerTurnId
    )
    .sort(
      (a, b) =>
        b.executionGeneration - a.executionGeneration ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        b.revision - a.revision
    )[0];
  return latest?.providerTurnId ?? null;
}

export function visibleTurnCitations(
  citations: readonly ManagedConversationTurnCitation[],
  providerTurnId: string
): ManagedConversationTurnCitation[] {
  return citations.filter(
    (citation) => citation.providerTurnId === providerTurnId
  );
}
