import type { DeploymentProfile } from "../server/capabilities.js";

const hostedTargetProfiles = new Set<DeploymentProfile>([
  "private_vps",
  "team_self_hosted",
  "koed_managed_cloud"
]);

export const isCrossIdentitySyncTargetProfile = (input: {
  deploymentProfile: DeploymentProfile;
  teamCollaborationEnabled: boolean;
  developerTeamBackendEnabled: boolean;
}): boolean =>
  hostedTargetProfiles.has(input.deploymentProfile) ||
  (input.deploymentProfile === "developer" &&
    input.teamCollaborationEnabled &&
    input.developerTeamBackendEnabled);

export const crossIdentitySyncTargetProfiles = (input: {
  teamCollaborationEnabled: boolean;
  developerTeamBackendEnabled: boolean;
}): Set<DeploymentProfile> =>
  new Set([
    ...hostedTargetProfiles,
    ...(input.teamCollaborationEnabled && input.developerTeamBackendEnabled
      ? (["developer"] as const)
      : [])
  ]);
