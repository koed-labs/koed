export type DesktopFeatureFlags = Readonly<{
  teamCollaborationEnabled: boolean;
}>;

export const desktopFeatureFlagsFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): DesktopFeatureFlags =>
  Object.freeze({
    teamCollaborationEnabled:
      environment.KOED_TEAM_COLLABORATION_ENABLED === "true"
  });
