import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  mkdirSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { KoedServerPaths } from "./paths.js";

export interface ProjectTeamWorkspaceLink {
  id: string;
  projectRoot: string;
  teamWorkspaceId: string;
  backendId: string | null;
  remotePrincipalId: string | null;
  deviceCredentialId: string | null;
  localProjectId: string | null;
  projectDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTeamWorkspaceLinkStore {
  schemaVersion: 1 | 2;
  updatedAt: string;
  links: ProjectTeamWorkspaceLink[];
}

export interface ProjectTeamWorkspaceLinkResult {
  ok: boolean;
  state: "linked" | "listed" | "found" | "removed" | "missing";
  message: string;
  link?: ProjectTeamWorkspaceLink;
  links?: ProjectTeamWorkspaceLink[];
}

export interface ProjectTeamWorkspaceLinkDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  mkdirSync?: typeof mkdirSync;
  now?: () => Date;
}

const depsWithDefaults = (
  deps: ProjectTeamWorkspaceLinkDeps = {}
): Required<ProjectTeamWorkspaceLinkDeps> => ({
  existsSync: deps.existsSync ?? existsSync,
  readFileSync: deps.readFileSync ?? readFileSync,
  writeFileSync: deps.writeFileSync ?? writeFileSync,
  renameSync: deps.renameSync ?? renameSync,
  mkdirSync: deps.mkdirSync ?? mkdirSync,
  now: deps.now ?? (() => new Date())
});

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizeProjectRoot = (projectRoot: string): string => {
  const trimmed = projectRoot.trim();
  if (!trimmed) {
    throw new Error("Project root is required.");
  }
  return resolve(trimmed);
};

const validateTeamWorkspaceId = (teamWorkspaceId: string): string => {
  const trimmed = teamWorkspaceId.trim();
  if (!uuidPattern.test(trimmed)) {
    throw new Error("Team Workspace id must be a UUID.");
  }
  return trimmed;
};

const validateBackendId = (backendId: string | undefined): string | null => {
  const trimmed = backendId?.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(trimmed)) {
    throw new Error(
      "Backend id must be 2-64 characters of letters, numbers, hyphen, or underscore."
    );
  }
  return trimmed;
};

const linkIdForProjectRoot = (projectRoot: string): string =>
  `ptw_${createHash("sha256").update(projectRoot).digest("hex").slice(0, 16)}`;

const validateLocalProjectId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^lp_[a-f0-9]{16,64}$/i.test(trimmed) ? trimmed : null;
};

const validateIdentityId = (value: unknown): string | null =>
  typeof value === "string" && uuidPattern.test(value.trim())
    ? value.trim().toLowerCase()
    : null;

const normalizeLink = (
  value: Partial<ProjectTeamWorkspaceLink>
): ProjectTeamWorkspaceLink | null => {
  if (
    typeof value.projectRoot !== "string" ||
    typeof value.teamWorkspaceId !== "string"
  ) {
    return null;
  }
  const projectRoot = normalizeProjectRoot(value.projectRoot);
  const teamWorkspaceId = validateTeamWorkspaceId(value.teamWorkspaceId);
  const backendId =
    typeof value.backendId === "string"
      ? validateBackendId(value.backendId)
      : null;
  const remotePrincipalId = validateIdentityId(value.remotePrincipalId);
  const deviceCredentialId = validateIdentityId(value.deviceCredentialId);
  if (backendId && (!remotePrincipalId || !deviceCredentialId)) return null;
  return {
    id:
      typeof value.id === "string"
        ? value.id
        : linkIdForProjectRoot(projectRoot),
    projectRoot,
    teamWorkspaceId,
    backendId,
    remotePrincipalId: backendId ? remotePrincipalId : null,
    deviceCredentialId: backendId ? deviceCredentialId : null,
    localProjectId: validateLocalProjectId(value.localProjectId),
    projectDisplayName:
      typeof value.projectDisplayName === "string" &&
      value.projectDisplayName.trim()
        ? value.projectDisplayName.trim().slice(0, 120)
        : null,
    createdAt:
      typeof value.createdAt === "string"
        ? value.createdAt
        : new Date(0).toISOString(),
    updatedAt:
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : new Date(0).toISOString()
  };
};

const readStore = (
  paths: KoedServerPaths,
  deps: Required<ProjectTeamWorkspaceLinkDeps>
): ProjectTeamWorkspaceLinkStore => {
  const now = deps.now().toISOString();
  if (!deps.existsSync(paths.projectTeamWorkspaceLinksPath)) {
    return { schemaVersion: 1, updatedAt: now, links: [] };
  }
  try {
    const parsed = JSON.parse(
      deps.readFileSync(paths.projectTeamWorkspaceLinksPath, "utf8") as string
    ) as Partial<ProjectTeamWorkspaceLinkStore>;
    return {
      schemaVersion: parsed.schemaVersion === 2 ? 2 : 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now,
      links: Array.isArray(parsed.links)
        ? parsed.links
            .map((link) => normalizeLink(link))
            .filter((link): link is ProjectTeamWorkspaceLink => Boolean(link))
        : []
    };
  } catch (error) {
    throw new Error("Project Team Workspace link config is malformed.", {
      cause: error
    });
  }
};

const writeStore = (
  paths: KoedServerPaths,
  store: ProjectTeamWorkspaceLinkStore,
  deps: Required<ProjectTeamWorkspaceLinkDeps>
): void => {
  deps.mkdirSync(dirname(paths.projectTeamWorkspaceLinksPath), {
    recursive: true,
    mode: 0o700
  });
  const tmpPath = `${paths.projectTeamWorkspaceLinksPath}.tmp`;
  deps.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600
  });
  deps.renameSync(tmpPath, paths.projectTeamWorkspaceLinksPath);
};

export const linkProjectTeamWorkspace = (
  paths: KoedServerPaths,
  input: {
    projectRoot: string;
    teamWorkspaceId: string;
    backendId?: string;
    remotePrincipalId?: string;
    deviceCredentialId?: string;
    localProjectId?: string;
    projectDisplayName?: string;
  },
  depsInput: ProjectTeamWorkspaceLinkDeps = {}
): ProjectTeamWorkspaceLinkResult => {
  const deps = depsWithDefaults(depsInput);
  const now = deps.now().toISOString();
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  const teamWorkspaceId = validateTeamWorkspaceId(input.teamWorkspaceId);
  const backendId = validateBackendId(input.backendId);
  const remotePrincipalId = validateIdentityId(input.remotePrincipalId);
  const deviceCredentialId = validateIdentityId(input.deviceCredentialId);
  if (backendId && (!remotePrincipalId || !deviceCredentialId)) {
    throw new Error(
      "Backend Project links require the remote principal and device credential identity."
    );
  }
  const store = readStore(paths, deps);
  const existing = store.links.find((link) => link.projectRoot === projectRoot);
  const link: ProjectTeamWorkspaceLink = {
    id: existing?.id ?? linkIdForProjectRoot(projectRoot),
    projectRoot,
    teamWorkspaceId,
    backendId,
    remotePrincipalId: backendId ? remotePrincipalId : null,
    deviceCredentialId: backendId ? deviceCredentialId : null,
    localProjectId:
      validateLocalProjectId(input.localProjectId) ??
      existing?.localProjectId ??
      null,
    projectDisplayName: input.projectDisplayName?.trim()
      ? input.projectDisplayName.trim().slice(0, 120)
      : (existing?.projectDisplayName ?? null),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const nextLinks = [
    ...store.links.filter((candidate) => candidate.projectRoot !== projectRoot),
    link
  ].sort((left, right) => left.projectRoot.localeCompare(right.projectRoot));
  writeStore(
    paths,
    { schemaVersion: 2, updatedAt: now, links: nextLinks },
    deps
  );
  return {
    ok: true,
    state: "linked",
    message: "Project linked to Team Workspace.",
    link
  };
};

export const listProjectTeamWorkspaceLinks = (
  paths: KoedServerPaths,
  depsInput: ProjectTeamWorkspaceLinkDeps = {}
): ProjectTeamWorkspaceLinkResult => {
  const store = readStore(paths, depsWithDefaults(depsInput));
  return {
    ok: true,
    state: "listed",
    message: `Found ${store.links.length} Project Team Workspace link(s).`,
    links: store.links
  };
};

export const getProjectTeamWorkspaceLink = (
  paths: KoedServerPaths,
  projectRoot: string,
  depsInput: ProjectTeamWorkspaceLinkDeps = {}
): ProjectTeamWorkspaceLinkResult => {
  const normalizedProjectRoot = normalizeProjectRoot(projectRoot);
  const store = readStore(paths, depsWithDefaults(depsInput));
  const link =
    store.links.find(
      (candidate) => candidate.projectRoot === normalizedProjectRoot
    ) ?? null;
  if (!link) {
    return {
      ok: false,
      state: "missing",
      message: "Project is not linked to a Team Workspace."
    };
  }
  return {
    ok: true,
    state: "found",
    message: "Project Team Workspace link found.",
    link
  };
};

export const removeProjectTeamWorkspaceLink = (
  paths: KoedServerPaths,
  projectRoot: string,
  depsInput: ProjectTeamWorkspaceLinkDeps = {}
): ProjectTeamWorkspaceLinkResult => {
  const deps = depsWithDefaults(depsInput);
  const normalizedProjectRoot = normalizeProjectRoot(projectRoot);
  const store = readStore(paths, deps);
  const existing = store.links.find(
    (candidate) => candidate.projectRoot === normalizedProjectRoot
  );
  if (!existing) {
    return {
      ok: false,
      state: "missing",
      message: "Project is not linked to a Team Workspace."
    };
  }
  const now = deps.now().toISOString();
  writeStore(
    paths,
    {
      schemaVersion: 2,
      updatedAt: now,
      links: store.links.filter(
        (candidate) => candidate.projectRoot !== normalizedProjectRoot
      )
    },
    deps
  );
  return {
    ok: true,
    state: "removed",
    message: "Project Team Workspace link removed.",
    link: existing
  };
};

export const removeProjectTeamWorkspaceLinksForBackend = (
  paths: KoedServerPaths,
  backendId: string,
  depsInput: ProjectTeamWorkspaceLinkDeps = {}
): number => {
  const deps = depsWithDefaults(depsInput);
  const normalizedBackendId = validateBackendId(backendId);
  if (!normalizedBackendId) return 0;
  const store = readStore(paths, deps);
  const links = store.links.filter(
    (link) => link.backendId !== normalizedBackendId
  );
  const removed = store.links.length - links.length;
  if (removed === 0) return 0;
  writeStore(
    paths,
    {
      schemaVersion: 2,
      updatedAt: deps.now().toISOString(),
      links
    },
    deps
  );
  return removed;
};

export const removeProjectTeamWorkspaceLinksForMismatchedBinding = (
  paths: KoedServerPaths,
  input: {
    backendId: string;
    remotePrincipalId: string;
    deviceCredentialId: string;
  },
  depsInput: ProjectTeamWorkspaceLinkDeps = {}
): number => {
  const deps = depsWithDefaults(depsInput);
  const backendId = validateBackendId(input.backendId);
  const remotePrincipalId = validateIdentityId(input.remotePrincipalId);
  const deviceCredentialId = validateIdentityId(input.deviceCredentialId);
  if (!backendId || !remotePrincipalId || !deviceCredentialId) {
    throw new Error("Project link binding is invalid.");
  }
  const store = readStore(paths, deps);
  const nextLinks = store.links.filter(
    (link) =>
      link.backendId !== backendId ||
      (link.remotePrincipalId === remotePrincipalId &&
        link.deviceCredentialId === deviceCredentialId)
  );
  const removed = store.links.length - nextLinks.length;
  if (removed === 0) return 0;
  writeStore(
    paths,
    {
      schemaVersion: 2,
      updatedAt: deps.now().toISOString(),
      links: nextLinks
    },
    deps
  );
  return removed;
};
