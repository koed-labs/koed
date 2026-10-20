import type { DesktopProject } from "../../../project-memory-ui.js";
import type { HqRoute } from "../hq-navigation.js";

export type HqCitationMessageTarget = {
  messageId: string;
  sessionId: string;
  projectId: string;
  threadId: string;
};

/** A citation can open only a captured, visible Personal conversation. */
export function resolveHqCitationMessageTarget(
  target: HqCitationMessageTarget,
  projects: readonly DesktopProject[],
  blockedSessions: ReadonlySet<string>
): HqRoute | null {
  if (
    !target.messageId ||
    !target.sessionId ||
    !target.projectId ||
    !target.threadId ||
    blockedSessions.has(`${target.projectId}\u0000${target.sessionId}`)
  )
    return null;
  const matches = projects.flatMap((project) =>
    project.id === target.projectId
      ? project.threads.filter(
          (thread) =>
            thread.id === target.threadId &&
            thread.projectId === target.projectId &&
            thread.sessionId === target.sessionId &&
            !thread.conversationTrashedAt
        )
      : []
  );
  return matches.length === 1
    ? {
        kind: "conversation",
        projectId: target.projectId,
        sessionId: target.sessionId
      }
    : null;
}
