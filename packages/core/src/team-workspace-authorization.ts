export type TeamWorkspaceAuthorizationRejectionReason =
  | "personal_only"
  | "missing_workspace_access"
  | "workspace_access_mismatch"
  | "workspace_access_disabled"
  | "team_entitlement_blocked";

export interface TeamWorkspaceAccessBoundary {
  teamWorkspaceId: string;
  teamId: string;
  userId: string;
  access: "disabled" | "read" | "write";
  canRecall: boolean;
  membershipStatus: "invited" | "enabled" | "disabled" | null;
  teamEntitlementStatus?: "active" | "grace" | "suspended" | "revoked";
  teamEntitlementAllowsAccess?: boolean;
}

export type TeamWorkspaceAuthorizationDecision =
  | {
      mode: "personal";
      authorized: false;
      reason: "personal_only";
    }
  | {
      mode: "team_workspace";
      authorized: true;
      teamWorkspaceId: string;
      teamId: string;
      userId: string;
      access: "read" | "write";
    }
  | {
      mode: "team_workspace";
      authorized: false;
      teamWorkspaceId: string;
      reason: Exclude<
        TeamWorkspaceAuthorizationRejectionReason,
        "personal_only"
      >;
    };

export const resolveTeamWorkspaceAuthorization = (input: {
  requesterUserId: string;
  teamWorkspaceId?: string;
  access?: TeamWorkspaceAccessBoundary | null;
}): TeamWorkspaceAuthorizationDecision => {
  if (!input.teamWorkspaceId) {
    return {
      mode: "personal",
      authorized: false,
      reason: "personal_only"
    };
  }

  const access = input.access;
  if (!access) {
    return {
      mode: "team_workspace",
      authorized: false,
      teamWorkspaceId: input.teamWorkspaceId,
      reason: "missing_workspace_access"
    };
  }

  if (
    access.teamWorkspaceId !== input.teamWorkspaceId ||
    access.userId !== input.requesterUserId
  ) {
    return {
      mode: "team_workspace",
      authorized: false,
      teamWorkspaceId: input.teamWorkspaceId,
      reason: "workspace_access_mismatch"
    };
  }

  if (access.teamEntitlementAllowsAccess === false) {
    return {
      mode: "team_workspace",
      authorized: false,
      teamWorkspaceId: input.teamWorkspaceId,
      reason: "team_entitlement_blocked"
    };
  }

  if (
    access.membershipStatus !== "enabled" ||
    !access.canRecall ||
    access.access === "disabled"
  ) {
    return {
      mode: "team_workspace",
      authorized: false,
      teamWorkspaceId: input.teamWorkspaceId,
      reason: "workspace_access_disabled"
    };
  }

  return {
    mode: "team_workspace",
    authorized: true,
    teamWorkspaceId: access.teamWorkspaceId,
    teamId: access.teamId,
    userId: access.userId,
    access: access.access
  };
};
