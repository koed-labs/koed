import type { Project } from "@koed/shared/project-contract";

export type SidebarTeam = {
  id: string;
  name: string;
  backendId: string;
  origin: "named" | "project_share";
  workspaceIds: readonly string[];
};

export type SidebarTeamGroup = SidebarTeam & { projectIds: readonly string[] };

/** Place Projects by their authoritative Team origin and Workspace links. */
export function groupSidebarProjects(
  projects: readonly Project[],
  teams: readonly SidebarTeam[]
): {
  sharedProjectIds: readonly string[];
  namedTeams: readonly SidebarTeamGroup[];
} {
  const linked = projects.filter(
    (project) => project.workspaceProjectId && project.teamWorkspaceId
  );
  const groupedIds = new Set<string>();
  const namedTeams: SidebarTeamGroup[] = [];
  for (const team of teams) {
    const projectIds = linked
      .filter(
        (project) =>
          project.teamBackendId === team.backendId &&
          team.workspaceIds.includes(project.teamWorkspaceId!)
      )
      .map((project) => project.id);
    if (team.origin === "project_share") continue;
    projectIds.forEach((id) => groupedIds.add(id));
    namedTeams.push({ ...team, projectIds });
  }
  return {
    sharedProjectIds: linked
      .filter((project) => !groupedIds.has(project.id))
      .map((project) => project.id),
    namedTeams
  };
}
