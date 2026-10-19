import {
  sessionSelectionId,
  type DesktopProject
} from "../../../project-memory-ui.js";
import type { ManagedConversationDraft } from "../../state/use-managed-conversation-lifecycle.js";

export function withPendingHqConversations(
  projects: readonly DesktopProject[],
  drafts: ReadonlyMap<string, ManagedConversationDraft> | undefined
): DesktopProject[] {
  if (!drafts?.size) return [...projects];
  return projects.map((project) => {
    const pending = [...drafts.values()].filter(
      (draft) =>
        draft.thread.projectId === project.id &&
        !project.threads.some(
          (thread) =>
            sessionSelectionId(thread) === draft.conversation.executionId ||
            thread.sessionId === draft.conversation.capturedSessionId ||
            thread.id === draft.conversation.threadId
        )
    );
    return pending.length
      ? {
          ...project,
          threads: [...pending.map((draft) => draft.thread), ...project.threads]
        }
      : project;
  });
}
