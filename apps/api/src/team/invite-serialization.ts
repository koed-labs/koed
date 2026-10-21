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
  void declinedAt;
  return invite.lifecycle === "declined"
    ? { ...legacy, declinedAt: invite.declinedAt }
    : legacy;
};
