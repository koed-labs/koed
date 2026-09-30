import type { PublicSquarePage, PublicSquarePublication, TeamProjectMemberConnection } from "@koed/shared/public-square";

export type PublicSquareScope = {
  backendId: string;
  principalUserId: string;
  teamId: string;
};

export type PublicSquareProject = { id: string; name: string };
export type PublicSquareProjectConnection = TeamProjectMemberConnection | null;

/** Launch-options may include this synthetic selector entry for projectless work. */
export const publicSquareConnectableLocalProjects = (projects: PublicSquareProject[]): PublicSquareProject[] =>
  projects.filter((project) => project.id !== "unassigned");

export const publicSquareBriefEditorValue = (
  item: PublicSquarePublication,
  typedDraft: string | undefined,
  ownerDraft: string | undefined
): string => typedDraft ?? item.sharedBrief ?? (item.canEditBrief ? ownerDraft : undefined) ?? "";

export const publicSquareNeedsOwnerDraft = (item: PublicSquarePublication, ownerDraft: string | undefined): boolean =>
  item.canEditBrief && item.sharedBrief === null && ownerDraft === undefined;

export type { PublicSquarePage, PublicSquarePublication, TeamProjectMemberConnection };

export const publicSquareScopeKey = (scope: PublicSquareScope): string =>
  JSON.stringify([scope.backendId, scope.principalUserId, scope.teamId]);

/** Canonical request dependency for Project connections; display arrays may be recreated each render. */
export const publicSquareProjectIdKey = (projects: PublicSquareProject[]): string =>
  [...new Set(projects.map((project) => project.id))].sort().join("\u0000");

/** Reject responses from an old account, Team, selection, or revoked view. */
export const publicSquareRequestMayApply = (input: {
  capturedScopeKey: string;
  currentScopeKey: string | null;
  capturedGeneration: number;
  currentGeneration: number;
  mounted: boolean;
  accessLost: boolean;
}): boolean => input.mounted && !input.accessLost &&
  input.capturedScopeKey === input.currentScopeKey &&
  input.capturedGeneration === input.currentGeneration;

/** Keep a late list response from restoring a brief withdrawn in this view. */
export const publicSquareVisibleBrief = (
  item: PublicSquarePublication,
  optimisticallyWithdrawnIds: ReadonlySet<string>
): string | null => optimisticallyWithdrawnIds.has(item.id) ? null : item.sharedBrief;

/** Keep a Team Project hidden while an unshare write is awaiting authoritative verification. */
export const publicSquareVisibleItems = (
  items: PublicSquarePublication[],
  optimisticallyUnsharedProjectIds: ReadonlySet<string>
): PublicSquarePublication[] => items.filter((item) => !optimisticallyUnsharedProjectIds.has(item.projectId));

export const publicSquareStatusLabel = (status: string): string => {
  const normalized = status.trim().toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
  if (!normalized) return "Status unavailable";
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
};

export const publicSquareIsCurrent = (item: PublicSquarePublication): boolean => {
  if (item.ownerLeftTeam) return false;
  const status = item.status === "offline" ? item.lastKnownStatus : item.status;
  return status === "queued" || status === "running" || status === "waiting";
};

export const publicSquareSortGroups = (items: PublicSquarePublication[]) => {
  const groups = new Map<string, { projectId: string; projectName: string; items: PublicSquarePublication[] }>();
  for (const item of items) {
    let group = groups.get(item.projectId);
    if (!group) {
      group = { projectId: item.projectId, projectName: item.projectName, items: [] };
      groups.set(item.projectId, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].sort((left, right) => left.projectName.localeCompare(right.projectName));
};
