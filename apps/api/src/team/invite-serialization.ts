import type { TeamInviteRecord } from "@koed/db";

/** Project admission handoffs are private protocol metadata, not a v1 DTO extension. */
export const legacyTeamInvite = (invite: TeamInviteRecord) => {
  const {
    workspaceProjectId,
    recipientUserId,
    recipientLeaveGeneration,
    issuanceMembershipVersion,
    issuanceMembershipStatus,
    issuanceDisabledReason,
    inviterAgentDisplayName,
    actorKind,
    accessMode,
    resultingAccessGrantVersion,
    declinedAt,
    ...legacy
  } = invite;
  void workspaceProjectId;
  void recipientUserId;
  void recipientLeaveGeneration;
  void issuanceMembershipVersion;
  void issuanceMembershipStatus;
  void issuanceDisabledReason;
  void inviterAgentDisplayName;
  void actorKind;
  void accessMode;
  void declinedAt;
  const withAcceptedVersion =
    invite.lifecycle === "accepted" && resultingAccessGrantVersion
      ? { ...legacy, resultingAccessGrantVersion }
      : legacy;
  return invite.lifecycle === "declined"
    ? { ...withAcceptedVersion, declinedAt: invite.declinedAt }
    : withAcceptedVersion;
};
