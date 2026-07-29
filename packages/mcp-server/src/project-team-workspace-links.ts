import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProjectTeamWorkspaceLink {
  projectRoot: string;
  teamWorkspaceId: string;
  backendId: string | null;
  localProjectId: string | null;
  projectDisplayName: string | null;
}

export interface ProjectTeamWorkspaceRoute {
  teamWorkspaceId: string | undefined;
  backendId: string | undefined;
}

export interface LocalProjectMetadataRecord {
  localProjectId: string;
  displayName: string;
  path: {
    cwd: string;
    projectRoot: string | null;
  };
}

const configRoot = (env: NodeJS.ProcessEnv): string =>
  env.KOED_HOME?.trim() || path.join(os.homedir(), ".koed");

const linkConfigPath = (env: NodeJS.ProcessEnv): string =>
  path.resolve(
    env.KOED_PROJECT_TEAM_WORKSPACE_LINKS_PATH?.trim() ||
      path.join(configRoot(env), "config", "project-team-workspaces.json")
  );

const projectMetadataPath = (env: NodeJS.ProcessEnv): string =>
  path.resolve(
    env.KOED_PROJECT_METADATA_PATH?.trim() ||
      path.join(configRoot(env), "config", "projects.json")
  );

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const teamWorkspaceAutoResolutionEnabled = (
  env: NodeJS.ProcessEnv = process.env
): boolean =>
  env.KOED_TEAM_WORKSPACE_AUTO_RESOLUTION_ENABLED?.trim() === "1" ||
  env.KOED_TEAM_WORKSPACE_AUTO_RESOLUTION_ENABLED?.trim().toLowerCase() ===
    "true";

export const readProjectMetadataForRoot = (
  projectRoot: string,
  env: NodeJS.ProcessEnv
): LocalProjectMetadataRecord | null => {
  const configPath = projectMetadataPath(env);
  if (!fs.existsSync(configPath)) return null;
  let parsed: {
    projects?: Array<Partial<LocalProjectMetadataRecord>>;
  };
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as typeof parsed;
  } catch {
    return null;
  }
  const normalizedProjectRoot = path.resolve(projectRoot);
  const project = parsed.projects?.find((candidate) => {
    const cwd =
      typeof candidate.path?.cwd === "string"
        ? path.resolve(candidate.path.cwd)
        : null;
    const root =
      typeof candidate.path?.projectRoot === "string"
        ? path.resolve(candidate.path.projectRoot)
        : null;
    return cwd === normalizedProjectRoot || root === normalizedProjectRoot;
  });
  if (
    !project ||
    typeof project.localProjectId !== "string" ||
    !project.localProjectId.trim()
  ) {
    return null;
  }
  const projectPath =
    typeof project.path?.projectRoot === "string"
      ? project.path.projectRoot
      : typeof project.path?.cwd === "string"
        ? project.path.cwd
        : normalizedProjectRoot;
  return {
    localProjectId: project.localProjectId.trim(),
    displayName:
      typeof project.displayName === "string" && project.displayName.trim()
        ? project.displayName.trim()
        : path.basename(projectPath) || "Project",
    path: {
      cwd:
        typeof project.path?.cwd === "string"
          ? project.path.cwd
          : normalizedProjectRoot,
      projectRoot:
        typeof project.path?.projectRoot === "string"
          ? project.path.projectRoot
          : null
    }
  };
};

const normalizeLink = (
  candidate: Partial<ProjectTeamWorkspaceLink>
): ProjectTeamWorkspaceLink | null => {
  if (
    typeof candidate.projectRoot !== "string" ||
    !candidate.projectRoot.trim() ||
    !uuidPattern.test(candidate.teamWorkspaceId ?? "")
  ) {
    return null;
  }
  return {
    projectRoot: path.resolve(candidate.projectRoot),
    teamWorkspaceId: candidate.teamWorkspaceId!,
    backendId:
      typeof candidate.backendId === "string" ? candidate.backendId : null,
    localProjectId:
      typeof candidate.localProjectId === "string"
        ? candidate.localProjectId
        : null,
    projectDisplayName:
      typeof candidate.projectDisplayName === "string"
        ? candidate.projectDisplayName
        : null
  };
};

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
  const links = (parsed.links ?? [])
    .map((candidate) => normalizeLink(candidate))
    .filter((candidate): candidate is ProjectTeamWorkspaceLink =>
      Boolean(candidate)
    );
  const exactMatches = links.filter(
    (candidate) => candidate.projectRoot === normalizedProjectRoot
  );
  if (exactMatches.length > 0) {
    return exactMatches.length === 1 ? exactMatches[0]! : null;
  }

  const project = readProjectMetadataForRoot(normalizedProjectRoot, env);
  if (!project?.localProjectId) return null;
  const localMatches = links.filter(
    (candidate) => candidate.localProjectId === project.localProjectId
  );
  return localMatches.length === 1 ? localMatches[0]! : null;
};

export const resolveProjectTeamWorkspaceRoute = (input: {
  projectRoot?: string;
  requestedTeamWorkspaceId?: string;
  env?: NodeJS.ProcessEnv;
}): ProjectTeamWorkspaceRoute => {
  const env = input.env ?? process.env;
  const configuredBackendId = env.KOED_TEAM_UPSTREAM_BACKEND_ID?.trim();
  const link = input.projectRoot
    ? resolveProjectTeamWorkspaceLink(input.projectRoot, env)
    : null;

  if (input.requestedTeamWorkspaceId) {
    return {
      teamWorkspaceId: input.requestedTeamWorkspaceId,
      backendId:
        link?.teamWorkspaceId === input.requestedTeamWorkspaceId
          ? (link.backendId ?? configuredBackendId)
          : configuredBackendId
    };
  }

  if (!link || !teamWorkspaceAutoResolutionEnabled(env)) {
    return { teamWorkspaceId: undefined, backendId: configuredBackendId };
  }

  return {
    teamWorkspaceId: link.teamWorkspaceId,
    backendId: link.backendId ?? configuredBackendId
  };
};
