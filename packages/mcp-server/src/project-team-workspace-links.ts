import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProjectTeamWorkspaceLink {
  projectRoot: string;
  teamWorkspaceId: string;
  backendId: string | null;
}

const linkConfigPath = (env: NodeJS.ProcessEnv): string =>
  path.resolve(
    env.KOED_PROJECT_TEAM_WORKSPACE_LINKS_PATH?.trim() ||
      path.join(
        env.KOED_HOME?.trim() || path.join(os.homedir(), ".koed"),
        "config",
        "project-team-workspaces.json"
      )
  );

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const teamMemoryDogfoodEnabled = (
  env: NodeJS.ProcessEnv = process.env
): boolean =>
  env.KOED_TEAM_MEMORY_DOGFOOD?.trim() === "1" ||
  env.KOED_TEAM_MEMORY_DOGFOOD?.trim().toLowerCase() === "true";

export const resolveProjectTeamWorkspaceLink = (
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): ProjectTeamWorkspaceLink | null => {
  const configPath = linkConfigPath(env);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    links?: Array<Partial<ProjectTeamWorkspaceLink>>;
  };
  const normalizedProjectRoot = path.resolve(projectRoot);
  const link = parsed.links?.find(
    (candidate) =>
      typeof candidate.projectRoot === "string" &&
      path.resolve(candidate.projectRoot) === normalizedProjectRoot
  );
  if (!link || !uuidPattern.test(link.teamWorkspaceId ?? "")) {
    return null;
  }
  return {
    projectRoot: normalizedProjectRoot,
    teamWorkspaceId: link.teamWorkspaceId!,
    backendId: typeof link.backendId === "string" ? link.backendId : null
  };
};
