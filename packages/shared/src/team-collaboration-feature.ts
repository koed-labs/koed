export const teamCollaborationFeatureEnvironmentName =
  "KOED_TEAM_COLLABORATION_ENABLED";

export const resolveTeamCollaborationEnabled = (
  environment: NodeJS.ProcessEnv = process.env
): boolean => {
  const configured = environment[teamCollaborationFeatureEnvironmentName];
  if (configured === undefined || configured === "") return false;
  if (configured === "true") return true;
  if (configured === "false") return false;
  throw new Error(
    `${teamCollaborationFeatureEnvironmentName} must be exactly "true" or "false"`
  );
};
