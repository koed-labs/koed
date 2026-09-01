export type DesktopFeatureFlags = Readonly<{
  developerTeamBackendEnabled: boolean;
}>;

export const desktopFeatureFlagsFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): DesktopFeatureFlags =>
  Object.freeze({
    developerTeamBackendEnabled:
      environment.KOED_DEVELOPER_TEAM_BACKEND_ENABLED === "true"
  });
