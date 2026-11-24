import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  effectivePersonalSourceFact,
  normalizeRecordedProjectDirectory,
  type PersonalFolderAssignment,
  type PersonalFolderReference
} from "@koed-labs/shared";
import {
  findPersonalFolderDirectory,
  personalFolderRegistrySchema,
  readPersonalFolderDirectoryMarkerAsync
} from "@koed-labs/shared/personal-local-folders";
import { inspectDeviceIdentityStatus } from "./device-identity.js";
import {
  createClientWorktreeLookup,
  type ClientWorktreeLookup
} from "./client-worktree-source.js";
import {
  folderHintFileMissing,
  inspectFolderHintFile,
  readFolderHintFile
} from "./folder-hint-file.js";
import {
  canScoreWorktreeParent,
  scoreFolderCreation,
  scoreFolderHint,
  scoreRepositoryAnchor,
  scoreWorktreeParentHint,
  type FolderHintInput,
  type FolderHintResult
} from "./folder-hint-confidence.js";
import {
  MAX_GIT_BYTES,
  readHintGit,
  readHintRemoteEvidence,
  type HintAssociationLookup
} from "./folder-hint-remote.js";
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
  /** Eligible history with unknown recording device; repository review only. */
  readonly allowUnknownRepositoryCandidate?: boolean;
  readonly recordedMetadataState: FolderHintInput["recordedMetadataState"];
  /** Absolute paths the transcript's tools touched. Unverified until checked. */
  readonly referencedPaths?: readonly string[];
  /** An existing Project rule for the candidate Folder, if the caller has one. */
  readonly project?: FolderHintInput["project"];
}

const MAX_ACTIVITY_ENTRIES = 200;
const MAX_REFERENCED_PATHS = 50;
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;

const toMs = (value: FolderHintConversation["firstConversationAt"]): number =>
  value === null ? Number.NaN : new Date(value).getTime();

const readStat = (path: string) => stat(path).catch(() => null);

const birthtimeMs = (birthtime: number) => (birthtime > 0 ? birthtime : null);

/** Newest modification time of the directory, its Git bookkeeping, and a
 * bounded sample of its top-level entries. Never reads file contents. */
const readActivityMs = async (
  directory: string,
  mtimeMs: number
): Promise<number> => {
  let newest = mtimeMs;
  const consider = async (path: string) => {
    const entry = await readStat(path);
    if (entry) newest = Math.max(newest, entry.mtimeMs);
  };
  for (const name of [".git/HEAD", ".git/index", ".git/logs/HEAD"])
    await consider(join(directory, name));
  try {
    const dir = await opendir(directory, { bufferSize: 1 });
    try {
      for (let visited = 0; visited < MAX_ACTIVITY_ENTRIES; visited++) {
        const entry = await dir.read();
        if (!entry) break;
        await consider(join(directory, entry.name));
      }
    } finally {
      await dir.close();
    }
  } catch {
    // Keep any activity evidence collected before an unreadable entry.
  }
  return newest;
};

/** True only for an existing file whose real path is strictly inside `root`. */
const hasContainedFile = async (
  root: string,
  paths: readonly string[] | undefined
): Promise<boolean> => {
  if (!paths?.length) return false;
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) return false;
  for (const candidate of paths.slice(0, MAX_REFERENCED_PATHS)) {
    const real = await realpath(resolve(candidate)).catch(() => null);
    if (!real) continue;
    const inside = relative(realRoot, real);
    if (
      inside &&
      !inside.startsWith("..") &&
      !inside.startsWith(sep) &&
      (await readStat(real))?.isFile()
    )
      return true;
  }
  return false;
};

const CLAUDE_WORKTREE_PATH = /^(.+)\/\.claude\/worktrees\/[^/]+(?:\/|$)/;

/** A plain .git directory or a copied gitfile is not a linked worktree. */
const readGitWorktreeMainRoot = async (
  directory: string
): Promise<string | null> => {
  const pointer = join(directory, ".git");
  if (!(await lstat(pointer).catch(() => null))?.isFile()) return null;
  const gitPaths = await readHintGit(directory, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir"
  ]);
  const [gitDir, common] = gitPaths?.split(/\r?\n/) ?? [];
  if (
    !gitDir ||
    !common ||
    basename(common) !== ".git" ||
    dirname(gitDir) !== join(common, "worktrees")
  )
    return null;
  const backlink = await readFolderHintFile(
    join(gitDir, "gitdir"),
    MAX_GIT_BYTES
  );
  if (!backlink?.trim()) return null;
  const target = await realpath(resolve(gitDir, backlink.trim())).catch(
    () => null
  );
  const actualPointer = await realpath(pointer).catch(() => null);
  return target && target === actualPointer
    ? normalizeRecordedProjectDirectory(dirname(common))
    : null;
};

const missingOnDisk = async (directory: string): Promise<boolean> => {
  try {
    await lstat(directory);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
};

/** Read-only registry lookup. It never registers a directory, so scoring a
 * hint cannot create the Folder it suggests. */
const lookupRegistry = async (
  paths: KoedServerPaths,
  ownerUserId: string,
  normalizedPath: string,
  deploymentId: string,
  deviceId: string
): Promise<FolderHintInput["registry"]> => {
  const registryPath = join(paths.configDir, "folder-contexts.json");
  const text = await inspectFolderHintFile(registryPath, MAX_REGISTRY_BYTES);
  if (text === folderHintFileMissing) return { state: "missing" };
  if (text === null) return { state: "unavailable" };
  let registry: ReturnType<typeof personalFolderRegistrySchema.parse>;
  try {
    registry = personalFolderRegistrySchema.parse(JSON.parse(text));
  } catch {
    return { state: "unavailable" };
  }
  const marker = await readPersonalFolderDirectoryMarkerAsync(
    normalizedPath
  ).catch(() => null);
  if (!marker) return { state: "unavailable" };
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

type FolderHintOptions = {
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Where per-client records live. Defaults to the current User's home. */
  homeDir?: string;
  /** Share one lazy Claude record index across a hint batch. */
  lookupClientWorktree?: ClientWorktreeLookup;
  /** Authenticated lookup for opted-in checkouts; must honor cancellation. */
  lookupAssociatedSelection?: HintAssociationLookup | undefined;
};

type WorktreeEvidence = NonNullable<FolderHintInput["worktree"]>;
type WorktreeOrigin = Pick<WorktreeEvidence, "link" | "rootPath">;

const findWorktreeOrigin = async (
  conversation: FolderHintConversation,
  cwd: string,
  usable: boolean,
  options: FolderHintOptions
): Promise<WorktreeOrigin | null> => {
  if (
    conversation.sourceRuntime === "claude-code" &&
    conversation.externalSessionId
  ) {
    const lookup =
      options.lookupClientWorktree ??
      createClientWorktreeLookup(
        options.homeDir === undefined ? {} : { homeDir: options.homeDir }
      );
    const record = await lookup(conversation, cwd);
    if (record?.state === "not-a-worktree") return null;
    if (record?.state === "worktree")
      return { link: "client-recorded", rootPath: record.originPath };
  }
  if (usable) {
    const rootPath = await readGitWorktreeMainRoot(cwd);
    return rootPath ? { link: "git-pointer", rootPath } : null;
  }
  if (!conversation.recordedRemoteFingerprint) return null;
  const root = CLAUDE_WORKTREE_PATH.exec(cwd)?.[1];
  const rootPath = root ? normalizeRecordedProjectDirectory(root) : null;
  return rootPath && (await missingOnDisk(cwd))
    ? { link: "path-convention", rootPath }
    : null;
};

const gatherWorktree = async (
  paths: KoedServerPaths,
  conversation: FolderHintConversation,
  origin: WorktreeOrigin,
  deploymentId: string,
  deviceId: string,
  lookupAssociatedSelection?: HintAssociationLookup
): Promise<WorktreeEvidence | undefined> => {
  const { rootPath } = origin;
  const mainStat = await readStat(rootPath);
  if (!mainStat?.isDirectory()) return;
  const registry = await lookupRegistry(
    paths,
    conversation.ownerUserId,
    rootPath,
    deploymentId,
    deviceId
  );
  return {
    ...origin,
    registry,
    currentRemoteFingerprint:
      (await readHintRemoteEvidence(paths, rootPath, lookupAssociatedSelection))
        ?.fingerprint ?? null,
    birthtimeMs: birthtimeMs(mainStat.birthtimeMs)
  };
};

const nanosecondsToMs = (ns: bigint) =>
  Number(ns / 1_000_000n) + Number(ns % 1_000_000n) / 1e6;

const checkoutIncarnation = ({ dev, ino, birthtimeNs }: BigIntStats) =>
  dev >= 0n && ino > 0n && birthtimeNs > 0n
    ? createHash("sha256").update(`${dev}:${ino}:${birthtimeNs}`).digest("hex")
    : undefined;

type GatheredFolderHintInput = FolderHintInput & {
  directoryIncarnation?: string;
  gitCheckoutIncarnation?: string;
  manualGitCheckoutIncarnation?: string;
};

const gatherCheckout = async (
  paths: KoedServerPaths,
  conversation: FolderHintConversation,
  cwd: string | null,
  deploymentId: string,
  deviceId: string,
  lookupAssociatedSelection?: HintAssociationLookup
): Promise<Pick<
  GatheredFolderHintInput,
  | "directoryStat"
  | "directoryIncarnation"
  | "gitDirectoryBirthtimeMs"
  | "gitCheckoutIncarnation"
  | "manualGitCheckoutIncarnation"
  | "currentRemoteFingerprint"
  | "registry"
  | "hasContainedTranscriptFile"
> | null> => {
  const directory = cwd
    ? await stat(cwd, { bigint: true }).catch(() => null)
    : null;
  if (!cwd || !directory?.isDirectory()) {
    return {
      directoryStat: null,
      currentRemoteFingerprint: null,
      registry: { state: "missing" },
      hasContainedTranscriptFile: false
    };
  }
  const git = await readHintRemoteEvidence(
    paths,
    cwd,
    lookupAssociatedSelection
  );
  const activityMs = await readActivityMs(
    cwd,
    nanosecondsToMs(directory.mtimeNs)
  );
  const registry = await lookupRegistry(
    paths,
    conversation.ownerUserId,
    cwd,
    deploymentId,
    deviceId
  );
  const hasContainedTranscriptFile = await hasContainedFile(
    cwd,
    conversation.referencedPaths
  );
  // Git's own identities can stay unchanged when only the recorded cwd is replaced.
  const current = await stat(cwd, { bigint: true }).catch(() => null);
  if (
    !current?.isDirectory() ||
    current.dev !== directory.dev ||
    current.ino !== directory.ino ||
    current.birthtimeNs !== directory.birthtimeNs
  )
    return null;
  const directoryIncarnation = checkoutIncarnation(directory);
  return {
    ...(directoryIncarnation ? { directoryIncarnation } : {}),
    ...(git?.gitCheckoutIncarnation
      ? { gitCheckoutIncarnation: git.gitCheckoutIncarnation }
      : {}),
    ...(git?.manualGitCheckoutIncarnation
      ? { manualGitCheckoutIncarnation: git.manualGitCheckoutIncarnation }
      : {}),
    gitDirectoryBirthtimeMs: git?.gitDirectoryBirthtimeMs ?? null,
    directoryStat: {
      isDirectory: true,
      birthtimeMs: birthtimeMs(nanosecondsToMs(directory.birthtimeNs)),
      activityMs
    },
    currentRemoteFingerprint: git?.fingerprint ?? null,
    registry,
    hasContainedTranscriptFile
  };
};

/** Collect current device-local evidence for one Conversation. Read-only. */
export const gatherFolderHintInput = async (
  paths: KoedServerPaths,
  conversation: FolderHintConversation,
  options: FolderHintOptions = {}
): Promise<GatheredFolderHintInput | null> => {
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
  const checkout = await gatherCheckout(
    paths,
    conversation,
    cwd,
    device.deploymentId,
    device.deviceInstanceId,
    options.lookupAssociatedSelection
  );
  if (!checkout) return null;
  const input: GatheredFolderHintInput = {
    ...checkout,
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
    recordedRemoteFingerprint: conversation.recordedRemoteFingerprint,
    ...(conversation.gitAnchorKnown !== undefined
      ? { gitAnchorKnown: conversation.gitAnchorKnown }
      : {}),
    ...(conversation.project ? { project: conversation.project } : {})
  };
  if (!cwd || !canScoreWorktreeParent(input)) return input;
  const origin = await findWorktreeOrigin(
    conversation,
    cwd,
    checkout.directoryStat !== null,
    options
  );
  if (!origin || origin.rootPath === cwd) return input;
  const worktree = await gatherWorktree(
    paths,
    conversation,
    origin,
    device.deploymentId,
    device.deviceInstanceId,
    options.lookupAssociatedSelection
  );
  return worktree ? { ...input, worktree } : input;
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
        /** Device-local evidence for Desktop revalidation, not part of the hint contract. */
        directoryIncarnation?: string;
        gitCheckoutIncarnation?: string;
        manualGitCheckoutIncarnation?: string;
      }
  );

/** Every credible candidate for one Conversation, best first: an existing
 * registered Folder, the main checkout of a linked worktree, then registering
 * the recorded directory as a new Folder. A caller that can use only some of
 * them (a Folder not yet in any Project cannot be shown) takes the first it can.
 * Returns null without a ready device identity or if the recorded directory
 * changed during checkout evidence collection; a lone `none` when there is no
 * candidate. Advisory only. */
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
  const anchor = scoreRepositoryAnchor(
    input,
    conversation.allowUnknownRepositoryCandidate
  );
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
            ...(input.recordedCwd ? { directory: input.recordedCwd } : {}),
            ...(input.directoryIncarnation
              ? { directoryIncarnation: input.directoryIncarnation }
              : {}),
            ...(input.gitCheckoutIncarnation
              ? { gitCheckoutIncarnation: input.gitCheckoutIncarnation }
              : {}),
            ...(input.manualGitCheckoutIncarnation
              ? {
                  manualGitCheckoutIncarnation:
                    input.manualGitCheckoutIncarnation
                }
              : {})
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
