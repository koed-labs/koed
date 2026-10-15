import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  statSync
} from "node:fs";
import path, { dirname, relative, resolve } from "node:path";
import {
  repositoryIdentityMatches,
  repositoryChangeInputSchema,
  type RepositoryChangeInput,
  deriveLocalProjectId,
  hmacProjectValue,
  mergeGitRemoteAliases,
  normalizeProjectDisplayName,
  normalizeRecordedProjectDirectory,
  repositoryIdentitySchema,
  type AssociatedRepositorySelection,
  type NormalizedGitRemote,
  type ProjectMetadataV1,
  type ProjectPackageMetadata
} from "@koed/shared";
import {
  createGitProjectProbe,
  probeGitProject,
  type GitProjectProbeResult
} from "./git-project-probe.js";
import { resolveRepositoryIdentity } from "./repository-identity.js";
import { lookupAcceptedProjectSelection } from "./project-associated-selection.js";
import type { KoedServerPaths } from "./paths.js";

export interface ProjectMetadataStore {
  schemaVersion: 3;
  updatedAt: string;
  deviceSaltId: string;
  projects: ProjectMetadataV1[];
  namedProjects: NamedProject[];
  repositoryChanges: RepositoryChangeInput[];
  checkouts: Array<{
    id: string;
    root: string;
    marker: string;
    selectedRemote?: string;
    repositoryRevision?: number;
    associationLookupRequired?: boolean;
  }>;
}

export interface NamedProject {
  id: string;
  name: string;
  createdAt: string;
  repository: import("@koed/shared").RepositoryIdentity;
}

export interface ProjectMetadataResult {
  ok: boolean;
  state: "discovered" | "listed" | "found" | "forgotten" | "missing";
  message: string;
  project?: ProjectMetadataV1;
  projects?: ProjectMetadataV1[];
  gitProbe?: Pick<GitProjectProbeResult, "status" | "failedCommands">;
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
  probeGit?: typeof probeGitProject;
  statSync?: typeof statSync;
  lookupAssociatedSelection?: typeof lookupAcceptedProjectSelection;
}

const depsWithDefaults = (
  deps: ProjectMetadataDeps = {}
): Required<ProjectMetadataDeps> => ({
  existsSync: deps.existsSync ?? existsSync,
  readFileSync: deps.readFileSync ?? readFileSync,
  writeFileSync: deps.writeFileSync ?? writeFileSync,
  renameSync: deps.renameSync ?? renameSync,
  mkdirSync: deps.mkdirSync ?? mkdirSync,
  statSync: deps.statSync ?? statSync,
  lookupAssociatedSelection:
    deps.lookupAssociatedSelection ?? lookupAcceptedProjectSelection,
  execFile: deps.execFile ?? nodeExecFile,
  now: deps.now ?? (() => new Date()),
  randomId: deps.randomId ?? randomUUID,
  probeGit:
    deps.probeGit ??
    (deps.execFile
      ? createGitProjectProbe({ execFile: deps.execFile })
      : probeGitProject)
});

const defaultStore = (
  now: string,
  deps: Required<ProjectMetadataDeps>
): ProjectMetadataStore => ({
  schemaVersion: 3,
  updatedAt: now,
  deviceSaltId: `pms_${deps.randomId()}`,
  repositoryChanges: [],
  checkouts: [],
  namedProjects: [],
  projects: []
});

/** Import-local folder grouping, without claiming a current checkout incarnation. */
export const historicalFolderRepositoryIdentity = (
  paths: KoedServerPaths,
  cwd: string | undefined,
  depsInput: ProjectMetadataDeps = {}
): import("@koed/shared").RepositoryIdentity | null => {
  const root = normalizeRecordedProjectDirectory(cwd);
  if (!root) return null;
  const deps = depsWithDefaults(depsInput);
  const store = readStore(paths, deps);
  if (!deps.existsSync(paths.projectMetadataPath))
    writeStore(paths, store, deps);
  return {
    kind: "non_git_project",
    key: `ng_${hmacProjectValue(store.deviceSaltId, JSON.stringify(["historical_folder", root])).slice(12)}`,
    root,
    branch: null,
    reason: "non_git",
    checkoutId: null,
    originatingDeviceId: store.deviceSaltId,
    selectedRemote: null,
    anchorDisplay: null
  };
};

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
      repositoryChanges: Array.isArray(parsed.repositoryChanges)
        ? parsed.repositoryChanges.map((change) =>
            repositoryChangeInputSchema.parse(change)
          )
        : [],
      checkouts: Array.isArray(parsed.checkouts)
        ? parsed.checkouts.filter(
            (entry) =>
              typeof entry.id === "string" &&
              typeof entry.root === "string" &&
              typeof entry.marker === "string" &&
              (entry.selectedRemote === undefined ||
                typeof entry.selectedRemote === "string") &&
              (entry.associationLookupRequired === undefined ||
                typeof entry.associationLookupRequired === "boolean")
          )
        : [],
      projects: Array.isArray(parsed.projects)
        ? parsed.projects
            .filter(isProjectMetadata)
            .map(normalizeProjectMetadata)
        : [],
      namedProjects: Array.isArray(parsed.namedProjects)
        ? parsed.namedProjects.map((project) => {
            if (
              !project ||
              typeof project.id !== "string" ||
              typeof project.name !== "string" ||
              !project.name.trim() ||
              project.name.length > 160 ||
              typeof project.createdAt !== "string"
            )
              throw new Error("Invalid named Project");
            const repository = repositoryIdentitySchema.parse(
              project.repository
            );
            if (repository.kind !== "local_project")
              throw new Error("Invalid named Project identity");
            return {
              id: project.id,
              name: project.name,
              createdAt: project.createdAt,
              repository
            };
          })
        : []
    };
    if (
      parsed.schemaVersion !== 3 ||
      parsed.deviceSaltId !== store.deviceSaltId
    ) {
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
  input: {
    cwd: string;
    aiClientSource?: "codex";
    associatedSelection?: AssociatedRepositorySelection;
  },
  depsInput: ProjectMetadataDeps = {}
): Promise<ProjectMetadataResult> => {
  const deps = depsWithDefaults(depsInput);
  let store = readStore(paths, deps);
  // Persist the profile salt before yielding to Git, so simultaneous producers
  // do not invent independent local identities on first discovery.
  if (!deps.existsSync(paths.projectMetadataPath))
    writeStore(paths, store, deps);
  const now = deps.now().toISOString();
  const cwd = resolve(input.cwd);
  const observation = await deps.probeGit({
    profile: paths.projectMetadataPath,
    cwd,
    deviceSalt: store.deviceSaltId
  });
  // Merge against the current local configuration after asynchronous probing.
  store = readStore(paths, deps);
  const gitRoot = observation.root;
  const remotes = observation.remotes;
  const checkoutRoot = gitRoot ?? cwd;
  let checkoutMarker: string | null = null;
  try {
    const stat = deps.statSync(observation.gitDir ?? checkoutRoot);
    checkoutMarker = JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs]);
  } catch {
    /* Missing checkout provenance stays unresolved. */
  }
  let checkout = store.checkouts.find(
    (entry) => entry.root === checkoutRoot && entry.marker === checkoutMarker
  );
  if (!checkout && checkoutMarker) {
    checkout = {
      id: `checkout_${deps.randomId()}`,
      root: checkoutRoot,
      marker: checkoutMarker
    };
    store.checkouts.push(checkout);
  }
  let associatedSelection = input.associatedSelection;
  if (
    !associatedSelection &&
    checkout?.associationLookupRequired &&
    checkout.selectedRemote === undefined
  ) {
    const checkoutId = checkout.id;
    const profileId = store.deviceSaltId;
    associatedSelection = await deps.lookupAssociatedSelection(paths, {
      originatingDeviceId: store.deviceSaltId,
      checkoutId
    });
    // Merge local explicit edits/forgetting that happened during the API lookup.
    store = readStore(paths, deps);
    const currentStat = deps.statSync(observation.gitDir ?? checkoutRoot);
    if (
      profileId !== store.deviceSaltId ||
      JSON.stringify([
        currentStat.dev,
        currentStat.ino,
        currentStat.birthtimeMs
      ]) !== checkoutMarker
    )
      throw new Error(
        "Checkout changed during association lookup; retry discovery"
      );
    checkout = store.checkouts.find(
      (entry) =>
        entry.id === checkoutId &&
        entry.marker === checkoutMarker &&
        entry.root === checkoutRoot
    );
    if (!checkout)
      throw new Error(
        "Checkout changed during association lookup; retry discovery"
      );
    if (!checkout.associationLookupRequired) associatedSelection = undefined;
  }
  const repository = resolveRepositoryIdentity({
    observation,
    cwd,
    deviceSalt: store.deviceSaltId,
    checkoutId: checkout?.id ?? null,
    localSelection: checkout?.selectedRemote,
    associatedSelection,
    commonDirMarker: (() => {
      try {
        const stat = deps.statSync(observation.commonDir!);
        return JSON.stringify([stat.dev, stat.ino, stat.birthtimeMs]);
      } catch {
        return null;
      }
    })()
  });

  const packages = discoverPackages(gitRoot, cwd, deps);
  const localProjectId = deriveLocalProjectId({
    salt: store.deviceSaltId,
    projectRoot: gitRoot,
    cwd
  });
  const previousProject = store.projects.find(
    (entry) =>
      entry.localProjectId === localProjectId &&
      entry.repository?.checkoutId === repository.checkoutId
  );
  const previous = previousProject?.repository;
  if (
    checkout &&
    previous &&
    previous.checkoutId === repository.checkoutId &&
    !(
      previous.kind === "unresolved" &&
      repository.kind === "unresolved" &&
      previous.reason === repository.reason
    ) &&
    !repositoryIdentityMatches(previous, repository)
  ) {
    checkout.repositoryRevision = (checkout.repositoryRevision ?? 0) + 1;
    store.repositoryChanges.push(
      repositoryChangeInputSchema.parse({
        id: randomUUID(),
        kind: "anchor_change",
        originatingDeviceId: repository.originatingDeviceId,
        checkoutId: checkout.id,
        originatingRevision: checkout.repositoryRevision,
        previousIdentity: previous,
        targetIdentity: repository
      })
    );
  }
  const remoteAliases = mergeGitRemoteAliases(
    previousProject?.git?.remoteAliases ?? [],
    previousProject?.git?.remotes ?? [],
    remotes
  );
  const {
    branch,
    headCommit,
    commonDir: resolvedCommonDir,
    gitDir: resolvedGitDir
  } = observation;
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
    repository,
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
    gitProbe: {
      status: observation.status,
      failedCommands: observation.failedCommands
    },
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

export const listNamedProjects = (
  paths: KoedServerPaths,
  depsInput: ProjectMetadataDeps = {}
): NamedProject[] =>
  readStore(paths, depsWithDefaults(depsInput)).namedProjects;

export const createNamedProject = (
  paths: KoedServerPaths,
  name: string,
  depsInput: ProjectMetadataDeps = {}
): NamedProject => {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 160)
    throw new Error("Enter a Project name of 1 to 160 characters.");
  const deps = depsWithDefaults(depsInput);
  const store = readStore(paths, deps);
  if (store.namedProjects.length >= 500)
    throw new Error("The local Project catalog is full.");
  const id = `project_${deps.randomId()}`;
  const project: NamedProject = {
    id,
    name: trimmed,
    createdAt: deps.now().toISOString(),
    repository: {
      kind: "local_project",
      key: id,
      reason: "manual",
      originatingDeviceId: store.deviceSaltId,
      root: null,
      branch: null,
      checkoutId: null,
      selectedRemote: null,
      anchorDisplay: null
    }
  };
  writeStore(
    paths,
    {
      ...store,
      updatedAt: project.createdAt,
      namedProjects: [...store.namedProjects, project]
    },
    deps
  );
  return project;
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

export const setProjectRepositoryAnchor = async (
  paths: KoedServerPaths,
  input: {
    localProjectId: string;
    expectedCheckoutId: string;
    remoteName: string | null;
  },
  depsInput: ProjectMetadataDeps = {}
): Promise<ProjectMetadataResult> => {
  if (
    input.remoteName !== null &&
    (!input.remoteName.trim() ||
      input.remoteName.length > 512 ||
      /\s/.test(input.remoteName))
  )
    throw new Error("Repository remote name is invalid.");
  const deps = depsWithDefaults(depsInput);
  const original = readStore(paths, deps).projects.find(
    (project) => project.localProjectId === input.localProjectId
  );
  if (!original) throw new Error("Project metadata not found.");
  // Rediscover before editing so a reused path cannot inherit an old selection.
  const discovery = await discoverProjectMetadata(
    paths,
    { cwd: original.path.projectRoot ?? original.path.cwd },
    depsInput
  );
  if (discovery.project?.repository?.checkoutId !== input.expectedCheckoutId)
    throw new Error(
      "Checkout changed. Inspect the Project again before selecting an anchor."
    );
  const store = readStore(paths, deps);
  const checkout = store.checkouts.find(
    (entry) => entry.id === input.expectedCheckoutId
  );
  if (!checkout) throw new Error("Checkout provenance is unavailable.");
  if (input.remoteName === null) delete checkout.selectedRemote;
  else checkout.selectedRemote = input.remoteName;
  writeStore(paths, store, deps);
  return discoverProjectMetadata(
    paths,
    { cwd: original.path.projectRoot ?? original.path.cwd },
    depsInput
  );
};

/** This local marker enables a lookup, never a selection or an inferred association. */
export const setProjectAssociationLookup = async (
  paths: KoedServerPaths,
  input: {
    localProjectId: string;
    expectedCheckoutId: string;
    enabled: boolean;
  },
  depsInput: ProjectMetadataDeps = {}
): Promise<void> => {
  const deps = depsWithDefaults(depsInput);
  const original = readStore(paths, deps).projects.find(
    (entry) => entry.localProjectId === input.localProjectId
  );
  if (!original) throw new Error("Local Project is unavailable");
  const discovery = await discoverProjectMetadata(
    paths,
    { cwd: original.path.projectRoot ?? original.path.cwd },
    depsInput
  );
  if (discovery.project?.repository?.checkoutId !== input.expectedCheckoutId)
    throw new Error("Checkout changed; inspect the Project again");
  const store = readStore(paths, deps);
  const checkout = store.checkouts.find(
    (entry) => entry.id === input.expectedCheckoutId
  );
  if (!checkout) throw new Error("Checkout provenance is unavailable");
  checkout.associationLookupRequired = input.enabled;
  writeStore(paths, store, deps);
};

/** Refresh accepted quiet checkouts for owner inspection without Conversation capture. */
export const refreshProjectAssociations = async (
  paths: KoedServerPaths,
  depsInput: ProjectMetadataDeps = {}
): Promise<void> => {
  const store = readStore(paths, depsWithDefaults(depsInput));
  for (const project of store.projects) {
    if (
      !store.checkouts.some(
        (entry) =>
          entry.id === project.repository?.checkoutId &&
          entry.associationLookupRequired
      )
    )
      continue;
    await discoverProjectMetadata(
      paths,
      { cwd: project.path.projectRoot ?? project.path.cwd },
      depsInput
    );
  }
};

export const listPendingRepositoryChanges = (
  paths: KoedServerPaths,
  depsInput: ProjectMetadataDeps = {}
): RepositoryChangeInput[] =>
  readStore(paths, depsWithDefaults(depsInput)).repositoryChanges;
export const acknowledgeRepositoryChange = (
  paths: KoedServerPaths,
  id: string,
  depsInput: ProjectMetadataDeps = {}
): void => {
  const deps = depsWithDefaults(depsInput);
  const store = readStore(paths, deps);
  store.repositoryChanges = store.repositoryChanges.filter(
    (change) => change.id !== id
  );
  writeStore(paths, store, deps);
};
