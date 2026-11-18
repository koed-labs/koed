export type DesktopFeatureFlags = Readonly<{
  teamCollaborationEnabled: boolean;
}>;

export const desktopTeamCollaborationValue = (
  environment: Readonly<Record<string, string | undefined>>
): string => environment.KOED_TEAM_COLLABORATION_ENABLED?.trim() || "false";

export const desktopFeatureFlagsFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): DesktopFeatureFlags =>
  Object.freeze({
    teamCollaborationEnabled:
      desktopTeamCollaborationValue(environment) === "true"
  });
