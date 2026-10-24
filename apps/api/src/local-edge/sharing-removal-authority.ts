import {
  sharingRemoveTargetSchema,
  type SharingAgentOverview
} from "@koed/shared";

type Target = ReturnType<typeof sharingRemoveTargetSchema.parse>;

/** A proposal binds exact current IDs; only Desktop's HQ-724 coordinator may execute it. */
export function createSharingRemovalAuthority(
  readForOwner: (ownerId: string) => Promise<SharingAgentOverview>,
  readInvitationLifecycle: (
    ownerId: string,
    backendId: string,
    teamId: string,
    invitationId: string
  ) => Promise<string | null> = () => Promise.resolve(null)
) {
  const inspect = (read: SharingAgentOverview, target: Target) => {
    const backend = read.overview.backends.find(
      (item) => item.backendId === target.backendId
    );
    const roster = read.teams.find(
      (item) => item.backendId === target.backendId
    );
    if (!backend || backend.status !== "available") return null;
    if (target.kind === "team_member") {
      if (!roster || roster.status !== "available") return null;
      const team = roster.teams.find((item) => item.teamId === target.teamId);
      if (!team || (team.role !== "owner" && team.role !== "admin"))
        return null;
      const person = team.people.find((item) => item.id === target.personId);
      return {
        present: person?.status === "enabled",
        manageable: person?.canRemove === true,
        version: person?.version ?? null,
        name: person?.name ?? target.personId
      };
    }
    if (
      target.kind === "project_member" ||
      target.kind === "project_invitation"
    ) {
      const project = backend.data.projects.find(
        (item) => item.id === target.projectId
      );
      if (!project || !project.ownedByMe) return null;
      const item =
        target.kind === "project_member"
          ? project.members.find(
              (member) => member.person.id === target.personId
            )
          : project.invitations.find(
              (invite) => invite.id === target.invitationId
            );
      return {
        present: Boolean(item),
        manageable: item
          ? item.kind === "workspace_access"
            ? item.canRemove
            : item.canCancel
          : false,
        version: item && "version" in item ? item.version : null,
        name: item?.person.displayName ?? target.projectId
      };
    }
    if (target.kind === "workspace_access") {
      const team =
        roster?.status === "available"
          ? roster.teams.find((item) => item.teamId === target.teamId)
          : null;
      if (!team || (team.role !== "owner" && team.role !== "admin"))
        return null;
      const item = backend.data.workspaceAccess.find(
        (access) =>
          access.workspaceProjectId === null &&
          access.teamId === target.teamId &&
          access.teamWorkspaceId === target.workspaceId &&
          access.person.id === target.personId
      );
      return {
        present: Boolean(item),
        manageable: item?.canRemove === true,
        version: item?.version ?? null,
        name: item?.person.displayName ?? target.personId
      };
    }
    const team =
      roster?.status === "available"
        ? roster.teams.find((item) => item.teamId === target.teamId)
        : null;
    if (!team || (team.role !== "owner" && team.role !== "admin")) return null;
    const item = backend.data.invitations.find(
      (invite) =>
        invite.workspaceProjectId === null &&
        invite.teamId === target.teamId &&
        invite.id === target.invitationId
    );
    return {
      present: Boolean(item),
      manageable: item?.canCancel === true,
      version: null,
      name: item?.person.displayName ?? target.invitationId
    };
  };
  return {
    proposal: async (input: {
      ownerUserId: string;
      targets: Record<string, unknown>[];
    }) => {
      const targets = input.targets.map((target) =>
        sharingRemoveTargetSchema.parse(target)
      );
      if (
        new Set(targets.map((target) => JSON.stringify(target))).size !==
        targets.length
      )
        return null;
      const read = await readForOwner(input.ownerUserId);
      const resolved = targets.map((target) => ({
        target,
        state: inspect(read, target)
      }));
      if (
        resolved.some((item) => !item.state?.present || !item.state.manageable)
      )
        return null;
      return resolved.map((item) => ({
        ...item.target,
        expectedVersion: item.state!.version,
        personName: item.state!.name
      }));
    },
    receipt: async (input: {
      ownerUserId: string;
      targets: Record<string, unknown>[];
    }) => {
      const read = await readForOwner(input.ownerUserId);
      const outcomes = await Promise.all(
        input.targets.map(async (item) => {
          const target = sharingRemoveTargetSchema.parse(item);
          const state = inspect(read, target);
          if (state === null) return false;
          if (
            target.kind === "project_invitation" ||
            target.kind === "team_invitation"
          ) {
            const backend = read.overview.backends.find(
              (item) => item.backendId === target.backendId
            );
            const teamId =
              target.kind === "team_invitation"
                ? target.teamId
                : backend?.status === "available"
                  ? backend.data.projects.find(
                      (project) => project.id === target.projectId
                    )?.teamId
                  : undefined;
            if (!teamId) return false;
            return (
              (await readInvitationLifecycle(
                input.ownerUserId,
                target.backendId,
                teamId,
                target.invitationId
              )) === "revoked"
            );
          }
          return !state.present;
        })
      );
      return outcomes.every(Boolean);
    }
  };
}
