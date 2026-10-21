import type { Project } from "@koed/shared/project-contract";
import type { CollaborationRendererClient } from "../../../collaboration/renderer-client.js";
import type {
  ProjectsDesktopApi,
  WorkspaceProjectShareContext
} from "../../../ipc/projects-protocol.js";

export type ShareProjectTarget =
  | { kind: "new_team" }
  | { kind: "team"; teamId: string }
  | { kind: "workspace"; teamId: string; workspaceId: string };

export interface ShareProjectOutcome {
  projectId: string;
  teamId: string;
  workspaceId: string;
  teamBackendId: string;
  invitationUrl: string | null;
  invitationError: string | null;
}

const requireReady = (
  context: WorkspaceProjectShareContext
): { backendId: string; principalId: string } => {
  if (context.state !== "ready" || !context.backendId || !context.principalId)
    throw new Error("Sign in to Koed cloud to share this Project.");
  return { backendId: context.backendId, principalId: context.principalId };
};

/** Renderer orchestration only. Each mutating step still receives its own
 * existing Native approval or authoritative HQ712 first-share check.
 */
export const createShareProjectFlow = (
  projects: ProjectsDesktopApi,
  collaboration: CollaborationRendererClient
) => {
  const attemptTargets = new Map<
    string,
    {
      backendId: string;
      principalId: string;
      teamId: string;
      workspaceId: string;
    }
  >();
  const context = async () => {
    if (!projects.sharedShareContext)
      throw new Error("Sharing is unavailable on this Desktop.");
    return projects.sharedShareContext();
  };
  return {
    context,
    async share(
      project: Project,
      target: ShareProjectTarget,
      shareAttemptKey: string,
      inviteEmail?: string
    ): Promise<ShareProjectOutcome> {
      if (project.workspaceProjectId)
        throw new Error("This Project is already shared.");
      if (!projects.sharedFirstShare)
        throw new Error("First-share service is unavailable.");
      const before = await context();
      const { backendId, principalId } = requireReady(before);
      let teamId: string;
      let workspaceId: string;
      const attemptId = `${project.id}:${shareAttemptKey}`;
      const resumed = attemptTargets.get(attemptId);
      const pending = await projects.sharedPendingShare?.(project.id);
      if (pending) {
        if (
          pending.teamBackendId !== backendId ||
          pending.shareAttemptKey !== shareAttemptKey ||
          (target.kind !== "new_team" &&
            target.teamId !== pending.targetTeamId) ||
          (target.kind === "workspace" &&
            target.workspaceId !== pending.targetWorkspaceId)
        )
          throw new Error(
            "A different first-share attempt is pending. Resume its original destination."
          );
        teamId = pending.targetTeamId;
        workspaceId = pending.targetWorkspaceId;
      } else if (resumed) {
        if (
          resumed.backendId !== backendId ||
          resumed.principalId !== principalId ||
          (target.kind !== "new_team" && target.teamId !== resumed.teamId) ||
          (target.kind === "workspace" &&
            target.workspaceId !== resumed.workspaceId)
        )
          throw new Error("Share attempt identity changed.");
        teamId = resumed.teamId;
        workspaceId = resumed.workspaceId;
      } else if (target.kind === "workspace") {
        const team = before.teams.find((item) => item.id === target.teamId);
        if (
          !team?.workspaces.some(
            (workspace) =>
              workspace.id === target.workspaceId &&
              workspace.access === "write"
          )
        )
          throw new Error(
            "Workspace write access is required to share this Project."
          );
        teamId = target.teamId;
        workspaceId = target.workspaceId;
      } else if (target.kind === "new_team") {
        await collaboration.createTeam({ name: `${project.name} shared` });
        const after = await context();
        if (after.backendId !== backendId || after.principalId !== principalId)
          throw new Error("Team identity changed during sharing.");
        const created = after.teams.filter(
          (team) => !before.teams.some((previous) => previous.id === team.id)
        );
        if (created.length !== 1 || created[0]!.workspaces.length !== 1)
          throw new Error("New Team could not be identified safely.");
        teamId = created[0]!.id;
        workspaceId = created[0]!.workspaces[0]!.id;
      } else {
        const team = before.teams.find((item) => item.id === target.teamId);
        if (!team || !["owner", "admin"].includes(team.role))
          throw new Error("You cannot add a Project to this Team.");
        await collaboration.createWorkspace({
          teamId: team.id,
          name: project.name,
          description: null
        });
        const after = await context();
        if (after.backendId !== backendId || after.principalId !== principalId)
          throw new Error("Team identity changed during sharing.");
        const updatedTeam = after.teams.find((item) => item.id === team.id);
        const created = updatedTeam?.workspaces.filter(
          (workspace) =>
            !team.workspaces.some((previous) => previous.id === workspace.id)
        );
        if (created?.length !== 1 || created[0]!.access !== "write")
          throw new Error("New Workspace could not be identified safely.");
        teamId = team.id;
        workspaceId = created[0]!.id;
      }
      attemptTargets.set(attemptId, {
        backendId,
        principalId,
        teamId,
        workspaceId
      });
      const current = await context();
      if (
        current.backendId !== backendId ||
        current.principalId !== principalId ||
        !current.teams
          .find((team) => team.id === teamId)
          ?.workspaces.some(
            (workspace) =>
              workspace.id === workspaceId && workspace.access === "write"
          )
      )
        throw new Error("Workspace authority changed before first share.");
      const shared = await projects.sharedFirstShare(project.id, backendId, {
        teamId,
        workspaceId,
        name: project.name,
        key: project.key,
        shareAttemptKey
      });
      if (shared.teamId !== teamId || shared.workspaceId !== workspaceId)
        throw new Error("First-share identity changed.");
      let invitationUrl: string | null = null;
      let invitationError: string | null = null;
      if (inviteEmail?.trim()) {
        try {
          const invitation = await collaboration.createInvitation({
            teamId,
            email: inviteEmail.trim(),
            role: "member",
            defaultWorkspaceId: workspaceId,
            workspaceProjectId: shared.id,
            expectedWorkspaceProjectVersion: shared.version,
            defaultWorkspaceAccess: "write",
            ttlHours: 72
          });
          invitationUrl = invitation.invitationUrl;
        } catch {
          invitationError =
            "The Project was shared, but the invitation was not created.";
        }
      }
      return {
        projectId: shared.id,
        teamId,
        workspaceId,
        teamBackendId: backendId,
        invitationUrl,
        invitationError
      };
    }
  };
};
