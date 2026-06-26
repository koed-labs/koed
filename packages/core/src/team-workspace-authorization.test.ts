import { describe, expect, it } from "vitest";
import { resolveTeamWorkspaceAuthorization } from "./team-workspace-authorization.js";

const access = {
  teamWorkspaceId: "workspace-a",
  teamId: "team-a",
  userId: "user-a",
  access: "read" as const,
  canRecall: true,
  membershipStatus: "enabled" as const
};

describe("resolveTeamWorkspaceAuthorization", () => {
  it("keeps calls personal-only when no Team Workspace is requested", () => {
    expect(
      resolveTeamWorkspaceAuthorization({ requesterUserId: "user-a" })
    ).toEqual({
      mode: "personal",
      authorized: false,
      reason: "personal_only"
    });
  });

  it("authorizes enabled Workspace readers", () => {
    expect(
      resolveTeamWorkspaceAuthorization({
        requesterUserId: "user-a",
        teamWorkspaceId: "workspace-a",
        access
      })
    ).toEqual({
      mode: "team_workspace",
      authorized: true,
      teamWorkspaceId: "workspace-a",
      teamId: "team-a",
      userId: "user-a",
      access: "read"
    });
  });

  it("rejects missing, mismatched, and disabled access", () => {
    expect(
      resolveTeamWorkspaceAuthorization({
        requesterUserId: "user-a",
        teamWorkspaceId: "workspace-a"
      })
    ).toMatchObject({ authorized: false, reason: "missing_workspace_access" });

    expect(
      resolveTeamWorkspaceAuthorization({
        requesterUserId: "user-b",
        teamWorkspaceId: "workspace-a",
        access
      })
    ).toMatchObject({ authorized: false, reason: "workspace_access_mismatch" });

    expect(
      resolveTeamWorkspaceAuthorization({
        requesterUserId: "user-a",
        teamWorkspaceId: "workspace-a",
        access: {
          ...access,
          access: "disabled",
          canRecall: false
        }
      })
    ).toMatchObject({ authorized: false, reason: "workspace_access_disabled" });
  });
});
