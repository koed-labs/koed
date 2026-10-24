import type { SharingOverview } from "@koed/shared/sharing-contract";

export type SharingRow = {
  key: string;
  backendId: string;
  teamId: string;
  projectId: string;
  invitationId: string | null;
  memberVersion: number | null;
  projectName: string;
  projectOwner: string;
  projectOwnerId: string | null;
  groupName: string;
  ownedByMe: boolean;
  personName: string;
  personId: string | null;
  status: "joined" | "invited";
  access: "edit" | "view";
  how: "direct" | "through_group" | "invitation";
  since: string;
  origin: {
    actorKind: "person" | "agent_on_behalf" | null;
    accessMode: "ask_first" | "full_access" | null;
    agentDisplayName: string | null;
    source:
      | { kind: "not_recorded" }
      | { kind: "share_window" }
      | { kind: "conversation"; conversationId: string };
  };
  canRemove: boolean;
  canCancel: boolean;
  contentCounts?: {
    sources: number;
    toDos: number;
    chatSummaries: number;
    sharedMemoryItems: number;
  };
};

export function sharingRows(overview: SharingOverview): SharingRow[] {
  return overview.backends.flatMap((backend) => {
    if (backend.status !== "available") return [];
    return backend.data.projects.flatMap((project) => [
      ...project.members.map((member) => ({
        key: `${backend.backendId}:access:${project.id}:${member.teamWorkspaceId}:${member.person.id ?? member.person.displayName}`,
        backendId: backend.backendId,
        teamId: project.teamId,
        projectId: project.id,
        invitationId: null,
        memberVersion: member.version,
        projectName: project.name,
        projectOwner: project.owner.displayName,
        projectOwnerId: project.owner.id,
        groupName: project.group.name,
        ownedByMe: project.ownedByMe,
        personName: member.person.displayName,
        personId: member.person.id,
        status: member.status,
        access: member.access,
        how: member.how,
        since: member.since,
        origin: member.origin,
        canRemove: member.canRemove,
        canCancel: false,
        contentCounts: project.contentCounts
      })),
      ...project.invitations.map((invite) => ({
        key: `${backend.backendId}:invite:${invite.id}`,
        backendId: backend.backendId,
        teamId: project.teamId,
        projectId: project.id,
        invitationId: invite.id,
        memberVersion: null,
        projectName: project.name,
        projectOwner: project.owner.displayName,
        projectOwnerId: project.owner.id,
        groupName: project.group.name,
        ownedByMe: project.ownedByMe,
        personName: invite.person.displayName,
        personId: invite.person.id,
        status: invite.status,
        access: invite.access,
        how: "invitation" as const,
        since: invite.since,
        origin: invite.origin,
        canRemove: false,
        canCancel: invite.canCancel,
        contentCounts: project.contentCounts
      }))
    ]);
  });
}

export const wordStartMatch = (value: string, query: string) =>
  value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .some((word) => word.startsWith(query.toLocaleLowerCase().trim()));

export const sharingGroups = (
  rows: readonly SharingRow[],
  by: "person" | "project"
) => [
  ...new Map(
    rows.map((row) =>
      by === "person"
        ? [
            `${row.backendId}:${row.personId ?? row.personName}`,
            {
              key: `${row.backendId}:${row.personId ?? row.personName}`,
              name: row.personName
            }
          ]
        : [
            `${row.backendId}:${row.projectId}`,
            { key: `${row.backendId}:${row.projectId}`, name: row.projectName }
          ]
    )
  ).values()
];

export const standaloneSharing = (overview: SharingOverview) =>
  overview.backends.flatMap((backend) =>
    backend.status === "available"
      ? [
          {
            backendId: backend.backendId,
            access: backend.data.workspaceAccess.filter(
              (item) => item.workspaceProjectId === null
            ),
            invitations: backend.data.invitations.filter(
              (item) => item.workspaceProjectId === null
            )
          }
        ]
      : []
  );
