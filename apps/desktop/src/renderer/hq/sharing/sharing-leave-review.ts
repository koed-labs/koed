import type { SharingOverview } from "@koed/shared/sharing-contract";

export type SharingLeaveTarget = {
  id: string;
  workspaceProjectId: string;
  teamBackendId: string;
  name: string;
};

/** A joined Team Project can be reviewed without creating a Personal link. */
export function sharingLeaveTarget(
  overview: SharingOverview | null,
  projectId: string,
  backendId: string,
  isCurrent: () => boolean
): SharingLeaveTarget | null {
  if (!isCurrent()) return null;
  const backend = overview?.backends.find(
    (item) => item.backendId === backendId && item.status === "available"
  );
  if (!backend || backend.status !== "available") return null;
  const project = backend.data.projects.find(
    (item) =>
      item.id === projectId && item.joinedByMe === true && !item.ownedByMe
  );
  if (!project || !isCurrent()) return null;
  return {
    id: `team:${backendId}:${projectId}`,
    workspaceProjectId: project.id,
    teamBackendId: backendId,
    name: project.name
  };
}
