import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  isPortableGitRemote,
  normalizeGitRemoteUrl,
  effectivePersonalSourceFact,
  normalizeRecordedProjectDirectory,
  type PersonalFolderAssignment,
  type PersonalFolderObservation,
  type PersonalFolderReference
} from "@koed-labs/shared";
import {
  findPersonalFolderDirectory,
  personalFolderRegistrySchema,
  readPersonalFolderDirectoryMarker
} from "@koed-labs/shared/personal-local-folders";
import { inspectDeviceIdentityStatus } from "./device-identity.js";
import { readClientWorktreeLink } from "./client-worktree-source.js";
import { observeCaptureFolder } from "./folder-context.js";
import {
  scoreFolderCreation,
  scoreFolderHint,
  scoreRepositoryAnchor,
  scoreWorktreeParentHint,
  type FolderHintInput,
  type FolderHintResult
} from "./folder-hint-confidence.js";
import type { KoedServerPaths } from "./paths.js";

/** Recorded facts about one Conversation. The server supplies these from its
 * own rows; this module adds only current, device-local filesystem evidence. */
export interface FolderHintConversation {
  readonly ownerUserId: string;
  readonly folderAssignment: PersonalFolderAssignment;
  readonly recordedCwd: string | null;
  /** A known origin device id. Ignored when `capturedOnThisDevice` is true. */
  readonly originDeviceId: string | null;
  /** The server captured this Conversation locally rather than receiving a
   * replica, so its origin is this device. A replica must leave this unset. */
  readonly capturedOnThisDevice?: boolean;
  /** The AI Client and its own session id, to read the client's worktree record. */
  readonly sourceRuntime?: string | null;
  readonly externalSessionId?: string | null;
  readonly firstConversationAt: string | number | Date | null;
  /** Fingerprint of the portable Git remote recorded with the Conversation. */
  readonly recordedRemoteFingerprint: string | null;
  /** The Conversation already has a Git Anchor (automatic or chosen). */
  readonly gitAnchorKnown?: boolean;
  readonly recordedMetadataState: FolderHintInput["recordedMetadataState"];
  /** Absolute paths the transcript's tools touched. Unverified until checked. */
  readonly referencedPaths?: readonly string[];
  /** An existing Project rule for the candidate Folder, if the caller has one. */
  readonly project?: FolderHintInput["project"];
}

const MAX_ACTIVITY_ENTRIES = 200;
const MAX_REFERENCED_PATHS = 50;
const GIT_TIMEOUT_MS = 2_000;

const toMs = (value: FolderHintConversation["firstConversationAt"]): number =>
  value === null ? Number.NaN : new Date(value).getTime();

const readStat = (path: string) => {
  try {
    const stat = statSync(path);
    return {
      isDirectory: stat.isDirectory(),
      birthtimeMs: stat.birthtimeMs > 0 ? stat.birthtimeMs : null,
      mtimeMs: stat.mtimeMs
    };
  } catch {
    return null;
  }
};

/** Newest modification time of the directory, its Git bookkeeping, and a
 * bounded sample of its top-level entries. Never reads file contents. */
const readActivityMs = (directory: string): number | null => {
  let newest = readStat(directory)?.mtimeMs ?? null;
  const consider = (path: string) => {
    const stat = readStat(path);
    if (stat && (newest === null || stat.mtimeMs > newest))
      newest = stat.mtimeMs;
  };
  for (const name of [".git/HEAD", ".git/index", ".git/logs/HEAD"])
    consider(join(directory, name));
  try {
    for (const entry of readdirSync(directory).slice(0, MAX_ACTIVITY_ENTRIES))
      consider(join(directory, entry));
  } catch {
    // An unreadable directory contributes no activity evidence.
  }
  return newest;
};

/** The directory's current portable remote fingerprint, or null. */
const readCurrentRemoteFingerprint = (directory: string): string | null => {
  try {
    const url = execFileSync(
      "git",
      ["-C", directory, "config", "--get", "remote.origin.url"],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      }
    ).trim();
    if (!url) return null;
    const remote = normalizeGitRemoteUrl(url);
    return isPortableGitRemote(remote) ? remote.fingerprint : null;
  } catch {
    return null;
  }
};

/** True only for an existing file whose real path is strictly inside `root`. */
const hasContainedFile = (
  root: string,
  paths: readonly string[] | undefined
): boolean => {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  for (const candidate of (paths ?? []).slice(0, MAX_REFERENCED_PATHS)) {
    try {
      const resolved = resolve(candidate);
      if (!existsSync(resolved)) continue;
      const real = realpathSync(resolved);
      const inside = relative(realRoot, real);
      if (
        inside &&
        !inside.startsWith("..") &&
        !inside.startsWith(sep) &&
        statSync(real).isFile()
      )
        return true;
    } catch {
      continue;
    }
  }
  return false;
};

const CLAUDE_WORKTREE_PATH = /^(.+)\/\.claude\/worktrees\/[^/]+(?:\/|$)/;

/** The main checkout a directory is a linked worktree of, or null. Git's own
 * `.git` pointer file is used while the directory exists; the Claude Code
 * worktree path convention covers a directory that has since been deleted. */
const readWorktreeMainRoot = (directory: string): string | null => {
  try {
    const pointer = join(directory, ".git");
    if (statSync(pointer).isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(pointer, "utf8"));
      if (match?.[1]) {
        const worktrees = dirname(resolve(directory, match[1].trim()));
        const common = dirname(worktrees);
        if (basename(worktrees) === "worktrees" && basename(common) === ".git")
          return normalizeRecordedProjectDirectory(dirname(common));
      }
    }
  } catch {
    // No readable pointer: fall through to the path convention.
  }
  const root = CLAUDE_WORKTREE_PATH.exec(directory)?.[1];
  return root ? normalizeRecordedProjectDirectory(root) : null;
};

/** Read-only registry lookup. It never registers a directory, so scoring a
 * hint cannot create the Folder it suggests. */
const lookupRegistry = (
  paths: KoedServerPaths,
  ownerUserId: string,
  normalizedPath: string,
  deploymentId: string,
  deviceId: string
): FolderHintInput["registry"] => {
  let marker: ReturnType<typeof readPersonalFolderDirectoryMarker>;
  try {
    marker = readPersonalFolderDirectoryMarker(normalizedPath);
  } catch {
    return { state: "missing" };
  }
  if (!marker) return { state: "missing" };
  const registryPath = join(paths.configDir, "folder-contexts.json");
  let registry: ReturnType<typeof personalFolderRegistrySchema.parse>;
  try {
    registry = personalFolderRegistrySchema.parse(
      JSON.parse(readFileSync(registryPath, "utf8"))
    );
  } catch {
    return { state: "missing" };
  }
  const entry = findPersonalFolderDirectory(
    registry.directories,
    normalizedPath,
    deploymentId,
    deviceId,
    marker
  );
  if (!entry) {
    // A volume-bound registration whose lookup failed now is ambiguous, not absent.
    const volumeBound =
      marker.marker === marker.deviceMarker &&
      registry.directories.some(
        (item) =>
          item.deploymentId === deploymentId &&
          item.deviceId === deviceId &&
          item.normalizedPath === normalizedPath &&
          item.marker.startsWith('["volume:')
      );
    return volumeBound ? { state: "ambiguous" } : { state: "missing" };
  }
  return {
    state: "matched",
    normalizedPath: entry.normalizedPath,
    folder: {
      ownerUserId,
      folderId: entry.folderId,
      originatingDeploymentId: deploymentId,
      originatingDeviceId: deviceId,
      originatingProfileId: registry.profileId,
      directoryIncarnationId: entry.incarnationId
    }
  };
};

/** Collect current device-local evidence for one Conversation. Read-only. */
export const gatherFolderHintInput = async (
  paths: KoedServerPaths,
  conversation: FolderHintConversation,
  options: {
    environment?: NodeJS.ProcessEnv;
    now?: () => number;
    /** Where per-client records live. Defaults to the current User's home. */
    homeDir?: string;
  } = {}
): Promise<FolderHintInput | null> => {
  const environment = options.environment ?? process.env;
  const evaluatedAtMs = (options.now ?? Date.now)();
  const device = await inspectDeviceIdentityStatus(paths, { environment });
  // Without a ready local identity no Folder can be a candidate here.
  if (
    !device.remoteOperationsAllowed ||
    !device.deploymentId ||
    !device.deviceInstanceId
  )
    return null;
  const original = conversation.folderAssignment.original;
  const cwd = normalizeRecordedProjectDirectory(conversation.recordedCwd);
  const stat = cwd ? readStat(cwd) : null;
  const usable = cwd !== null && stat?.isDirectory === true;
  const registry: FolderHintInput["registry"] = usable
    ? lookupRegistry(
        paths,
        conversation.ownerUserId,
        cwd,
        device.deploymentId,
        device.deviceInstanceId
      )
    : { state: "missing" };
  const clientLink = cwd
    ? readClientWorktreeLink(
        conversation,
        cwd,
        options.homeDir ? { homeDir: options.homeDir } : {}
      )
    : null;
  const inferredRoot =
    cwd && clientLink?.state !== "not-a-worktree"
      ? readWorktreeMainRoot(cwd)
      : null;
  const mainRoot =
    clientLink?.state === "worktree" ? clientLink.originPath : inferredRoot;
  const link: NonNullable<FolderHintInput["worktree"]>["link"] =
    clientLink?.state === "worktree"
      ? "client-recorded"
      : mainRoot && cwd && existsSync(join(cwd, ".git"))
        ? "git-pointer"
        : "path-convention";
  const mainStat = mainRoot && mainRoot !== cwd ? readStat(mainRoot) : null;
  const worktree: FolderHintInput["worktree"] =
    mainRoot && mainStat?.isDirectory
      ? {
          link,
          rootPath: mainRoot,
          registry: lookupRegistry(
            paths,
            conversation.ownerUserId,
            mainRoot,
            device.deploymentId,
            device.deviceInstanceId
          ),
          currentRemoteFingerprint: readCurrentRemoteFingerprint(mainRoot),
          birthtimeMs: mainStat.birthtimeMs
        }
      : undefined;
  return {
    effectiveFolderStatus: effectivePersonalSourceFact(
      conversation.folderAssignment
    ).state,
    originalFolderReason:
      original.state === "unresolved" ? original.reason : null,
    recordedMetadataState: conversation.recordedMetadataState,
    recordedCwd: conversation.recordedCwd,
    originDeviceId: conversation.capturedOnThisDevice
      ? device.deviceInstanceId
      : conversation.originDeviceId,
    currentDeviceId: device.deviceInstanceId,
    firstConversationAtMs: toMs(conversation.firstConversationAt),
    evaluatedAtMs,
    directoryStat:
      usable && stat
        ? {
            isDirectory: true,
            birthtimeMs: stat.birthtimeMs,
            activityMs: readActivityMs(cwd)
          }
        : null,
    recordedRemoteFingerprint: conversation.recordedRemoteFingerprint,
    ...(conversation.gitAnchorKnown !== undefined
      ? { gitAnchorKnown: conversation.gitAnchorKnown }
      : {}),
    currentRemoteFingerprint: usable ? readCurrentRemoteFingerprint(cwd) : null,
    registry,
    hasContainedTranscriptFile: usable
      ? hasContainedFile(cwd, conversation.referencedPaths)
      : false,
    ...(worktree ? { worktree } : {}),
    ...(conversation.project ? { project: conversation.project } : {})
  };
};

export type FolderHintCandidate = Pick<FolderHintResult, "score" | "reasons"> &
  (
    | { tier: "none" }
    | {
        tier: "strong" | "medium";
        kind: "registered" | "worktree-parent";
        folder: Readonly<PersonalFolderReference>;
        /** The Folder's directory on this device, for display. */
        directory?: string;
      }
    | { tier: "strong" | "medium"; kind: "create"; directory: string }
    | {
        tier: "medium";
        kind: "repository";
        repositoryKey: string;
        directory?: string;
      }
  );

/** Every credible candidate for one Conversation, best first: an existing
 * registered Folder, the main checkout of a linked worktree, then registering
 * the recorded directory as a new Folder. A caller that can use only some of
 * them (a Folder not yet in any Project cannot be shown) takes the first it can.
 * Returns null without a ready device identity; a lone `none` when there is
 * no candidate. Advisory only. */
export const hintsForConversation = async (
  paths: KoedServerPaths,
  conversation: FolderHintConversation,
  options?: Parameters<typeof gatherFolderHintInput>[2]
): Promise<FolderHintCandidate[] | null> => {
  const input = await gatherFolderHintInput(paths, conversation, options);
  if (!input) return null;
  const registered = scoreFolderHint(input);
  const parent = scoreWorktreeParentHint(input);
  const creation = scoreFolderCreation(input);
  const anchor = scoreRepositoryAnchor(input);
  const candidates: FolderHintCandidate[] = [
    ...(registered.tier !== "none"
      ? [
          {
            ...registered,
            kind: "registered" as const,
            ...(input.registry.state === "matched"
              ? { directory: input.registry.normalizedPath }
              : {})
          }
        ]
      : []),
    ...(parent.tier !== "none"
      ? [
          {
            ...parent,
            kind: "worktree-parent" as const,
            ...(input.worktree ? { directory: input.worktree.rootPath } : {})
          }
        ]
      : []),
    ...(anchor.tier !== "none"
      ? [
          {
            ...anchor,
            kind: "repository" as const,
            ...(input.recordedCwd ? { directory: input.recordedCwd } : {})
          }
        ]
      : []),
    ...(creation.tier !== "none"
      ? [{ ...creation, kind: "create" as const }]
      : [])
  ];
  return candidates.length > 0
    ? candidates
    : [{ tier: "none", score: registered.score, reasons: registered.reasons }];
};

/** The best single candidate. */
export const hintForConversation = async (
  paths: KoedServerPaths,
  conversation: FolderHintConversation,
  options?: Parameters<typeof gatherFolderHintInput>[2]
): Promise<FolderHintCandidate | null> =>
  (await hintsForConversation(paths, conversation, options))?.[0] ?? null;

/** The only write in this module, and only at an explicit User confirmation.
 * It re-checks that the chosen candidate still holds, then registers its
 * directory exactly as live capture would (a no-op for a directory that is
 * already registered) and returns the observation so the Folder can be recorded
 * on the Conversation. Returns null when the candidate no longer qualifies, so
 * a stale or forged request cannot register anything. */
export const createHintedFolder = async (
  paths: KoedServerPaths,
  conversation: FolderHintConversation,
  options?: Parameters<typeof gatherFolderHintInput>[2] & {
    kind?: "registered" | "worktree-parent" | "create";
  }
): Promise<PersonalFolderObservation | null> => {
  const input = await gatherFolderHintInput(paths, conversation, options);
  if (!input) return null;
  const kind = options?.kind ?? "create";
  let directory: string | undefined;
  if (kind === "create") {
    const creation = scoreFolderCreation(input);
    if (creation.tier !== "none") directory = creation.directory;
  } else if (kind === "registered") {
    if (
      scoreFolderHint(input).tier !== "none" &&
      input.registry.state === "matched"
    )
      directory = input.registry.normalizedPath;
  } else if (scoreWorktreeParentHint(input).tier !== "none") {
    directory = input.worktree?.rootPath;
  }
  if (!directory) return null;
  return (
    (await observeCaptureFolder(paths, directory, options?.environment)) ?? null
  );
};
