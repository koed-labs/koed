import type { SidebarConversation } from "./project-sidebar-model.js";

/**
 * Opens the sidebar row for a session the Kin asked to show. On a miss it may
 * start one inventory read, but only when none is in flight: the store's
 * latest read decides when the rows are current, so an older read can't block
 * a fresh request or hold back its timeout. Retries pass `refresh: false` and
 * only check the rows.
 */
export function openKinConversation(input: {
  sessionId: string;
  groups: readonly { conversations: readonly SidebarConversation[] }[];
  open: (row: SidebarConversation) => void;
  reading: () => boolean;
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
  if (input.options?.refresh !== false && !input.reading()) input.refresh();
  return false;
}
