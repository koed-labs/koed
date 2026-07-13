import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path, { dirname, relative, resolve } from "node:path";
import {
  deriveLocalProjectId,
  hmacProjectValue,
  mergeGitRemoteAliases,
  normalizeGitRemoteUrl,
  normalizeProjectDisplayName,
  type NormalizedGitRemote,
  type ProjectMetadataV1,
  type ProjectPackageMetadata
} from "@koed/shared";
import type { KoedServerPaths } from "./paths.js";

export interface ProjectMetadataStore {
  schemaVersion: 3;
  updatedAt: string;
  deviceSaltId: string;
  projects: ProjectMetadataV1[];
}

export interface ProjectMetadataResult {
  ok: boolean;
  state: "discovered" | "listed" | "found" | "forgotten" | "missing";
  message: string;
  project?: ProjectMetadataV1;
  projects?: ProjectMetadataV1[];
}

export interface ProjectMetadataDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  mkdirSync?: typeof mkdirSync;
  execFile?: typeof nodeExecFile;
  now?: () => Date;
  randomId?: () => string;
}

const depsWithDefaults = (
  deps: ProjectMetadataDeps = {}
): Required<ProjectMetadataDeps> => ({
  existsSync: deps.existsSync ?? existsSync,
  readFileSync: deps.readFileSync ?? readFileSync,
  writeFileSync: deps.writeFileSync ?? writeFileSync,
  renameSync: deps.renameSync ?? renameSync,
  mkdirSync: deps.mkdirSync ?? mkdirSync,
  execFile: deps.execFile ?? nodeExecFile,
  now: deps.now ?? (() => new Date()),
  randomId: deps.randomId ?? randomUUID
});

const defaultStore = (
  now: string,
  deps: Required<ProjectMetadataDeps>
): ProjectMetadataStore => ({
  schemaVersion: 3,
  updatedAt: now,
  deviceSaltId: `pms_${deps.randomId()}`,
  projects: []
});

const readStore = (
  paths: KoedServerPaths,
  deps: Required<ProjectMetadataDeps>
): ProjectMetadataStore => {
  const now = deps.now().toISOString();
  if (!deps.existsSync(paths.projectMetadataPath)) {
    return defaultStore(now, deps);
  }
  try {
    const parsed = JSON.parse(
      deps.readFileSync(paths.projectMetadataPath, "utf8") as string
    ) as Partial<ProjectMetadataStore>;
    const store: ProjectMetadataStore = {
      schemaVersion: 3,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now,
      deviceSaltId:
        typeof parsed.deviceSaltId === "string" && parsed.deviceSaltId.trim()
          ? parsed.deviceSaltId.trim()
          : `pms_${deps.randomId()}`,
      projects: Array.isArray(parsed.projects)
        ? parsed.projects
            .filter(isProjectMetadata)
            .map(normalizeProjectMetadata)
        : []
    };
    if (parsed.schemaVersion !== 3) {
      writeStore(paths, store, deps);
    }
    return store;
  } catch (error) {
    throw new Error("Project metadata config is malformed.", { cause: error });
  }
};

const writeStore = (
  paths: KoedServerPaths,
  store: ProjectMetadataStore,
  deps: Required<ProjectMetadataDeps>
): void => {
  deps.mkdirSync(dirname(paths.projectMetadataPath), {
    recursive: true,
    mode: 0o700
  });
  const tmpPath = `${paths.projectMetadataPath}.tmp`;
  deps.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600
  });
  deps.renameSync(tmpPath, paths.projectMetadataPath);
};

const isProjectMetadata = (value: unknown): value is ProjectMetadataV1 =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
  typeof (value as { localProjectId?: unknown }).localProjectId === "string" &&
  typeof (value as { displayName?: unknown }).displayName === "string" &&
  Boolean((value as { path?: unknown }).path);

const isNormalizedGitRemote = (
  value: unknown
): value is NormalizedGitRemote => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const remote = value as Partial<NormalizedGitRemote>;
  return (
    typeof remote.name === "string" &&
    (remote.host === null || typeof remote.host === "string") &&
    (remote.namespace === null || typeof remote.namespace === "string") &&
    (remote.repo === null || typeof remote.repo === "string") &&
    (remote.display === null || typeof remote.display === "string") &&
    typeof remote.fingerprint === "string"
  );
};

const withoutField = <Value extends object>(
  value: Value,
  field: string
): Value => {
  const copy = { ...value } as Value & Record<string, unknown>;
  delete copy[field];
  return copy;
};

const normalizeProjectMetadata = (
  value: ProjectMetadataV1
): ProjectMetadataV1 => {
  const legacy = value as ProjectMetadataV1 & {
    sourceProjectId?: unknown;
    git?: ProjectMetadataV1["git"] & {
      remoteSetFingerprint?: unknown;
      commonDirHash?: unknown;
      remoteAliases?: unknown;
    };
  };
  const metadata = withoutField(legacy, "sourceProjectId");
  if (!metadata.git) return metadata;
  const git = withoutField(metadata.git, "remoteSetFingerprint");
  const remotes = Array.isArray(git.remotes)
    ? git.remotes.filter(isNormalizedGitRemote)
    : [];
  const storedAliases = Array.isArray(git.remoteAliases)
    ? git.remoteAliases.filter(isNormalizedGitRemote)
    : [];
  return {
    ...metadata,
    git: {
      ...git,
      commonDirHash:
        typeof git.commonDirHash === "string" ? git.commonDirHash : null,
      remotes,
      remoteAliases: mergeGitRemoteAliases(storedAliases, remotes)
    }
  };
};

const git = async (
  cwd: string,
  args: string[],
  deps: Required<ProjectMetadataDeps>
): Promise<string | null> =>
  await new Promise((resolveValue) => {
    deps.execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 5_000 },
      (error, stdout) => {
        if (error) {
          resolveValue(null);
          return;
        }
        resolveValue(String(stdout).trim() || null);
      }
    );
  });

const readGitRemotes = async (
  cwd: string,
  deps: Required<ProjectMetadataDeps>
): Promise<NormalizedGitRemote[]> => {
  const raw = await git(cwd, ["remote", "-v"], deps);
  if (!raw) return [];
  const byNameAndUrl = new Map<string, NormalizedGitRemote>();
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url] = match;
    if (!name || !url) continue;
    byNameAndUrl.set(`${name}\n${url}`, normalizeGitRemoteUrl(url, name));
  }
  return [...byNameAndUrl.values()].sort((left, right) =>
    `${left.name}:${left.fingerprint}`.localeCompare(
      `${right.name}:${right.fingerprint}`
    )
  );
};

const readPackageName = (
  packageJsonPath: string,
  deps: Required<ProjectMetadataDeps>
): string | null => {
  try {
    const parsed = JSON.parse(
      deps.readFileSync(packageJsonPath, "utf8") as string
    ) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name.trim()
      : null;
  } catch {
    return null;
  }
};

const discoverPackages = (
  projectRoot: string | null,
  cwd: string,
  deps: Required<ProjectMetadataDeps>
): ProjectPackageMetadata[] => {
  const root = projectRoot ?? cwd;
  const packageJsonPath = resolve(root, "package.json");
  if (!deps.existsSync(packageJsonPath)) {
    return [];
  }
  const manager: ProjectPackageMetadata["manager"] = deps.existsSync(
    resolve(root, "pnpm-lock.yaml")
  )
    ? "pnpm"
    : deps.existsSync(resolve(root, "package-lock.json"))
      ? "npm"
      : deps.existsSync(resolve(root, "yarn.lock"))
        ? "yarn"
        : deps.existsSync(resolve(root, "bun.lockb"))
          ? "bun"
          : "unknown";
  return [
    {
      manager,
      name: readPackageName(packageJsonPath, deps),
      relativePath: relative(root, packageJsonPath) || "package.json"
    }
  ];
};

export const discoverProjectMetadata = async (
  paths: KoedServerPaths,
  input: { cwd: string; aiClientSource?: "codex" },
  depsInput: ProjectMetadataDeps = {}
): Promise<ProjectMetadataResult> => {
  const deps = depsWithDefaults(depsInput);
  const store = readStore(paths, deps);
  const now = deps.now().toISOString();
  const cwd = resolve(input.cwd);
  const projectRoot = await git(cwd, ["rev-parse", "--show-toplevel"], deps);
  const gitRoot = projectRoot ? resolve(projectRoot) : null;
  const remotes = gitRoot ? await readGitRemotes(gitRoot, deps) : [];
  const packages = discoverPackages(gitRoot, cwd, deps);
  const localProjectId = deriveLocalProjectId({
    salt: store.deviceSaltId,
    projectRoot: gitRoot,
    cwd
  });
  const previousProject = store.projects.find(
    (entry) => entry.localProjectId === localProjectId
  );
  const remoteAliases = mergeGitRemoteAliases(
    previousProject?.git?.remoteAliases ?? [],
    previousProject?.git?.remotes ?? [],
    remotes
  );
  const branch = gitRoot
    ? await git(gitRoot, ["branch", "--show-current"], deps)
    : null;
  const headCommit = gitRoot
    ? await git(gitRoot, ["rev-parse", "HEAD"], deps)
    : null;
  const commonDir = gitRoot
    ? await git(gitRoot, ["rev-parse", "--git-common-dir"], deps)
    : null;
  const gitDir = gitRoot
    ? await git(gitRoot, ["rev-parse", "--git-dir"], deps)
    : null;
  const resolvedCommonDir =
    gitRoot && commonDir ? resolve(gitRoot, commonDir) : null;
  const resolvedGitDir = gitRoot && gitDir ? resolve(gitRoot, gitDir) : null;
  const isWorktree = Boolean(
    resolvedCommonDir && resolvedGitDir && resolvedCommonDir !== resolvedGitDir
  );
  const displayName = normalizeProjectDisplayName({
    cwd,
    projectRoot: gitRoot,
    packages,
    remotes
  });
  const project: ProjectMetadataV1 = {
    schemaVersion: 1,
    discoveredAt: previousProject?.discoveredAt ?? now,
    lastSeenAt: now,
    localProjectId,
    displayName,
    path: {
      cwd,
      projectRoot: gitRoot,
      basename: path.basename(gitRoot ?? cwd),
      localPathHash: hmacProjectValue(store.deviceSaltId, gitRoot ?? cwd)
    },
    ...(gitRoot
      ? {
          git: {
            rootHash: hmacProjectValue(store.deviceSaltId, gitRoot),
            commonDirHash: resolvedCommonDir
              ? hmacProjectValue(store.deviceSaltId, resolvedCommonDir)
              : null,
            remotes,
            remoteAliases,
            branch,
            headCommit,
            isWorktree,
            worktreeHash: isWorktree
              ? hmacProjectValue(store.deviceSaltId, gitRoot)
              : null
          }
        }
      : {}),
    packages,
    ...(input.aiClientSource
      ? {
          aiClient: {
            cwdHash: hmacProjectValue(store.deviceSaltId, cwd),
            cwdBasename: path.basename(cwd),
            source: input.aiClientSource
          }
        }
      : {})
  };
  const projects = [
    ...store.projects.filter(
      (entry) => entry.localProjectId !== localProjectId
    ),
    project
  ].sort((left, right) => left.displayName.localeCompare(right.displayName));
  writeStore(paths, { ...store, updatedAt: now, projects }, deps);
  return {
    ok: true,
    state: "discovered",
    message: "Project metadata discovered.",
    project
  };
};

export const listProjectMetadata = (
  paths: KoedServerPaths,
  depsInput: ProjectMetadataDeps = {}
): ProjectMetadataResult => {
  const store = readStore(paths, depsWithDefaults(depsInput));
  return {
    ok: true,
    state: "listed",
    message: `Found ${store.projects.length} Project metadata record(s).`,
    projects: store.projects
  };
};

export const getProjectMetadataForCwd = (
  paths: KoedServerPaths,
  cwd: string,
  depsInput: ProjectMetadataDeps = {}
): ProjectMetadataResult => {
  const resolvedCwd = resolve(cwd);
  const store = readStore(paths, depsWithDefaults(depsInput));
  const project =
    store.projects.find(
      (entry) =>
        entry.path.cwd === resolvedCwd || entry.path.projectRoot === resolvedCwd
    ) ?? null;
  if (!project) {
    return {
      ok: false,
      state: "missing",
      message: "Project metadata not found."
    };
  }
  return {
    ok: true,
    state: "found",
    message: "Project metadata found.",
    project
  };
};

export const forgetProjectMetadata = (
  paths: KoedServerPaths,
  localProjectId: string,
  depsInput: ProjectMetadataDeps = {}
): ProjectMetadataResult => {
  const deps = depsWithDefaults(depsInput);
  const store = readStore(paths, deps);
  const project = store.projects.find(
    (entry) => entry.localProjectId === localProjectId
  );
  if (!project) {
    return {
      ok: false,
      state: "missing",
      message: "Project metadata not found."
    };
  }
  const now = deps.now().toISOString();
  writeStore(
    paths,
    {
      ...store,
      updatedAt: now,
      projects: store.projects.filter(
        (entry) => entry.localProjectId !== localProjectId
      )
    },
    deps
  );
  return {
    ok: true,
    state: "forgotten",
    message: "Project metadata forgotten.",
    project
  };
};
