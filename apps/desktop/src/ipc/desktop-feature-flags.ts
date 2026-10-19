export type DesktopFeatureFlags = Readonly<{
  hqEnabled: boolean;
  teamCollaborationEnabled: boolean;
}>;

export const desktopFeatureFlagsFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): DesktopFeatureFlags =>
  Object.freeze({
    hqEnabled: environment.KOED_DESKTOP_HQ_ENABLED === "true",
    teamCollaborationEnabled:
      environment.KOED_TEAM_COLLABORATION_ENABLED === "true"
  });
