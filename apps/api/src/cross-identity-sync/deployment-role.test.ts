import { describe, expect, it } from "vitest";
import {
  crossIdentitySyncTargetProfiles,
  isCrossIdentitySyncTargetProfile
} from "./deployment-role.js";

describe("Cross-Identity Sync deployment roles", () => {
  it("treats only an explicitly enabled developer Team backend as a target", () => {
    expect(
      isCrossIdentitySyncTargetProfile({
        deploymentProfile: "developer",
        teamCollaborationEnabled: true,
        developerTeamBackendEnabled: true
      })
    ).toBe(true);
    expect(
      isCrossIdentitySyncTargetProfile({
        deploymentProfile: "developer",
        teamCollaborationEnabled: true,
        developerTeamBackendEnabled: false
      })
    ).toBe(false);
    expect(
      isCrossIdentitySyncTargetProfile({
        deploymentProfile: "developer",
        teamCollaborationEnabled: false,
        developerTeamBackendEnabled: true
      })
    ).toBe(false);
  });

  it("keeps hosted profiles as targets and local_personal as a source", () => {
    const profiles = crossIdentitySyncTargetProfiles({
      teamCollaborationEnabled: false,
      developerTeamBackendEnabled: false
    });
    expect([...profiles]).toEqual([
      "private_vps",
      "team_self_hosted",
      "koed_managed_cloud"
    ]);
    expect(profiles.has("local_personal")).toBe(false);
    expect(profiles.has("developer")).toBe(false);
  });
});
