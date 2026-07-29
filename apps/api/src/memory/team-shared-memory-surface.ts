export const rejectUnavailableTeamSharedMemorySurface = (
  teamWorkspaceId: string | undefined,
  surface: "evidence" | "expansion" | "graph"
): void => {
  if (!teamWorkspaceId) return;

  throw Object.assign(
    new Error(`Team Shared Memory ${surface} is not available`),
    { statusCode: 404 }
  );
};
