export type DesktopFeatureFlags = Readonly<{
  teamCollaborationEnabled: boolean;
  // Personal Device Sync is opt-in; Desktop hides its controls while it is off.
  personalDeviceSyncEnabled: boolean;
}>;

export const desktopTeamCollaborationValue = (
  environment: Readonly<Record<string, string | undefined>>
): string => environment.KOED_TEAM_COLLABORATION_ENABLED?.trim() || "false";

export const desktopFeatureFlagsFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): DesktopFeatureFlags =>
  Object.freeze({
    teamCollaborationEnabled:
      desktopTeamCollaborationValue(environment) === "true",
    personalDeviceSyncEnabled:
      environment.KOED_PERSONAL_DEVICE_SYNC_ENABLED === "true"
  });
