import type { SidebarConversation } from "./project-sidebar-model.js";

/**
 * Opens the sidebar row for a session the Kin asked to show. A click whose
 * row is missing starts one inventory read of its own: any read already in
 * flight started before the click, so it can't be trusted to include the
 * newly captured Conversation. The store keeps only its latest read's result,
 * and the held request waits for that read. Retries pass `refresh: false` and
 * only check the rows, so each click costs at most one read.
 */
export function openKinConversation(input: {
  sessionId: string;
  groups: readonly { conversations: readonly SidebarConversation[] }[];
  open: (row: SidebarConversation) => void;
  refresh: () => void;
  options?: { refresh?: boolean };
}): boolean {
  const { sessionId } = input;
  for (const group of input.groups) {
    const row = group.conversations.find(
      (conversation) =>
        conversation.sessionId === sessionId ||
        conversation.sourceSessionIds?.includes(sessionId)
    );
    if (!row) continue;
    input.open(row);
    return true;
  }
  if (input.options?.refresh !== false) input.refresh();
  return false;
}
