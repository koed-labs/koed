import type { TeamInviteRecord } from "@koed/db";

/** Project admission handoffs are private protocol metadata, not a v1 DTO extension. */
export const legacyTeamInvite = (invite: TeamInviteRecord) => {
  const { workspaceProjectId, ...legacy } = invite;
  void workspaceProjectId;
  return legacy;
};
