import { describe, expect, it } from "vitest";
import type { SharingOverview } from "@koed/shared/sharing-contract";
import { sharingLeaveTarget } from "./sharing-leave-review.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const overview: SharingOverview = {
  backends: [
    {
      backendId: "team-a",
      status: "available",
      reachedAt: "2026-10-24T10:00:00.000Z",
      data: {
        projects: [
          {
            id: projectId,
            teamId: "00000000-0000-4000-8000-000000000002",
            teamWorkspaceId: "00000000-0000-4000-8000-000000000003",
            name: "Ana’s Project",
            owner: {
              id: "00000000-0000-4000-8000-000000000004",
              displayName: "Ana"
            },
            group: {
              id: "00000000-0000-4000-8000-000000000002",
              name: "Team"
            },
            ownedByMe: false,
            joinedByMe: true,
            members: [],
            invitations: [],
            counts: { members: 0, invitations: 0 }
          }
        ],
        invitations: [],
        workspaceAccess: []
      },
      incomingInvitations: []
    }
  ]
};

describe("HQ-723 Team-only Leave review target", () => {
  it("opens only exact joined backend/project authority", () => {
    expect(
      sharingLeaveTarget(overview, projectId, "team-a", () => true)
    ).toEqual({
      id: `team:team-a:${projectId}`,
      workspaceProjectId: projectId,
      teamBackendId: "team-a",
      name: "Ana’s Project"
    });
    expect(
      sharingLeaveTarget(overview, projectId, "team-b", () => true)
    ).toBeNull();
  });
  it("N27 refuses stale owner or changed route before opening review", () => {
    let ownerCurrent = true;
    let routeCurrent = true;
    const current = () => ownerCurrent && routeCurrent;
    ownerCurrent = false;
    expect(
      sharingLeaveTarget(overview, projectId, "team-a", current)
    ).toBeNull();
    ownerCurrent = true;
    routeCurrent = false;
    expect(
      sharingLeaveTarget(overview, projectId, "team-a", current)
    ).toBeNull();
  });
});
