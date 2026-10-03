import type { CollaborationSnapshot } from "@koed/shared/collaboration";
import type { StudioNotificationNavigation } from "@koed/shared/studio-notifications";

export type AuthorizedStudioNotificationDestination = {
  teamId: string;
  threadId: string;
  rootMessageId: string | null;
};

/** Resolve a notification hint only against the current authenticated Team snapshot. */
export function findAuthorizedStudioNotificationDestination(
  snapshot: CollaborationSnapshot,
  navigation: StudioNotificationNavigation
): AuthorizedStudioNotificationDestination | null {
  if (navigation.kind !== "team_thread") return null;

  const team = snapshot.navigation.teams.find(
    (candidate) => candidate.id === navigation.teamId
  );
  if (!team) return null;

  const threads = [
    ...team.channels,
    ...team.sharedProjects.map((project) => project.thread),
    ...team.directMessages
  ];
  const thread = threads.find(
    (candidate) => candidate.id === navigation.threadId
  );
  if (!thread) return null;

  return {
    teamId: team.id,
    threadId: thread.id,
    rootMessageId: navigation.rootMessageId
  };
}
