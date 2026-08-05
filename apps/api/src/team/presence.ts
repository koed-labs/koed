import type {
  TeamManagementMemberRecord,
  TeamRosterMemberRecord
} from "@koed/db";
import {
  coarsePresenceFromTeamPresence,
  deriveTeamPresenceSnapshot
} from "@koed/shared";

type PresenceSource = Pick<
  TeamRosterMemberRecord,
  | "presenceMode"
  | "manualPresenceStatus"
  | "presenceVersion"
  | "lastHumanActivityAt"
>;

export const publicTeamMemberPresence = (
  member: PresenceSource,
  nowMs = Date.now()
) => {
  const teamPresence = deriveTeamPresenceSnapshot(
    {
      mode: member.presenceMode,
      manualStatus: member.manualPresenceStatus,
      lastActivityAt: member.lastHumanActivityAt,
      preferenceVersion: member.presenceVersion
    },
    nowMs
  );
  return {
    presence: coarsePresenceFromTeamPresence(teamPresence),
    teamPresence
  };
};

export const publicTeamRosterMember = (
  member: TeamRosterMemberRecord,
  nowMs = Date.now()
) => {
  return {
    userId: member.userId,
    displayName: member.displayName,
    avatarReference: member.avatarReference,
    status: member.status,
    ...publicTeamMemberPresence(member, nowMs)
  };
};

export const publicTeamManagementMember = (
  member: TeamManagementMemberRecord,
  nowMs = Date.now()
) => {
  return {
    id: member.id,
    teamId: member.teamId,
    userId: member.userId,
    role: member.role,
    status: member.status,
    version: member.version,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
    acceptedAt: member.acceptedAt,
    disabledAt: member.disabledAt,
    email: member.email,
    displayName: member.displayName,
    avatarReference: member.avatarReference,
    workspaceAccess: member.workspaceAccess,
    ...publicTeamMemberPresence(member, nowMs)
  };
};
