import {
  normalizeRecordedProjectDirectory,
  type PersonalFolderAssignment,
  type PersonalFolderReference,
  type PersonalProjectReference
} from "@koed-labs/shared";

type FolderFact = PersonalFolderAssignment["original"];
type FolderReason = Extract<FolderFact, { state: "unresolved" }>["reason"];
type RegistryLookup =
  | Readonly<{
      state: "matched";
      folder: Readonly<PersonalFolderReference>;
      normalizedPath: string;
    }>
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "ambiguous" }>
  | Readonly<{ state: "unavailable" }>;
type ProjectContext = Readonly<{
  scope: "personal" | "shared" | "workspace-linked";
  reference: Readonly<PersonalProjectReference>;
}>;

export interface FolderHintInput {
  readonly effectiveFolderStatus: FolderFact["state"];
  readonly originalFolderReason: FolderReason | null;
  readonly recordedMetadataState: "resolved" | "absent" | "conflicting";
  readonly recordedCwd: string | null;
  readonly originDeviceId: string | null;
  readonly currentDeviceId: string;
  readonly firstConversationAtMs: number;
  readonly evaluatedAtMs: number;
  readonly directoryStat: Readonly<{
    isDirectory: boolean;
    birthtimeMs: number | null;
    activityMs: number | null;
  }> | null;
  readonly recordedRemoteFingerprint: string | null;
  readonly currentRemoteFingerprint: string | null;
  /** Birthtime of Git's per-worktree directory, not its shared common directory. */
  readonly gitDirectoryBirthtimeMs?: number | null;
  /** The Conversation already has a Git Anchor, so none needs suggesting. */
  readonly gitAnchorKnown?: boolean;
  /**
   * The caller verifies a match for the relevant User, deployment, and local
   * profile, including the current directory marker. The scorer checks the
   * normalized path and current device; it does not perform a registry lookup.
   */
  readonly registry: RegistryLookup;
  /** The caller verifies existence and strict containment on disk. */
  readonly hasContainedTranscriptFile: boolean;
  /** The caller establishes this Project's existing rule for the candidate Folder. */
  readonly project?: ProjectContext;
  /** The main checkout the recorded directory is a linked worktree of. The
   * caller derives it from Git's own pointer or a known worktree path
   * convention, then reads the checkout's current state. */
  readonly worktree?: Readonly<{
    /** How the link was found: recorded by the client, or inferred. */
    link?: "client-recorded" | "git-pointer" | "path-convention";
    rootPath: string;
    registry: RegistryLookup;
    currentRemoteFingerprint: string | null;
    birthtimeMs: number | null;
  }>;
}

type Outcome = "agrees" | "does-not-agree" | "unavailable" | "rejects";
type Reason = Readonly<{
  code:
    | "folder-eligibility"
    | "recorded-metadata"
    | "recorded-cwd"
    | "local-directory"
    | "origin-device"
    | "directory-birthtime"
    | "git-directory-birthtime"
    | "git-remote"
    | "live-registry-match"
    | "registry-marker-ambiguous"
    | "registry-unavailable"
    | "registry-folder-missing"
    | "registry-path-mismatch"
    | "registry-device-mismatch"
    | "directory-activity"
    | "contained-transcript-file"
    | "directory-remote"
    | "directory-not-registered"
    | "worktree-link-recorded"
    | "worktree-link-git"
    | "worktree-parent-registered"
    | "worktree-parent-remote"
    | "worktree-parent-birthtime";
  outcome: Outcome;
}>;

export type FolderHintResult = {
  score: number;
  reasons: readonly Reason[];
} & (
  | { tier: "none" }
  | {
      tier: "strong" | "medium";
      folder: Readonly<PersonalFolderReference>;
      project?: ProjectContext;
      action: "suggestion-only";
    }
);

const recentActivityMs = 30 * 24 * 60 * 60 * 1000;
const validTimestamp = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value >= 0;

const assessBirthtime = (
  birthtimeMs: number | null,
  firstConversationAtMs: number,
  evaluatedAtMs: number,
  sameDevice: boolean
): Outcome => {
  if (
    !validTimestamp(birthtimeMs) ||
    birthtimeMs === 0 ||
    !validTimestamp(firstConversationAtMs)
  )
    return "unavailable";
  if (birthtimeMs > firstConversationAtMs) return "rejects";
  if (!validTimestamp(evaluatedAtMs) || firstConversationAtMs > evaluatedAtMs)
    return "unavailable";
  return sameDevice && birthtimeMs < firstConversationAtMs
    ? "agrees"
    : "does-not-agree";
};

const assessActivity = (
  activityMs: number | null,
  evaluatedAtMs: number
): Outcome => {
  if (!validTimestamp(activityMs) || !validTimestamp(evaluatedAtMs))
    return "unavailable";
  const ageMs = evaluatedAtMs - activityMs;
  return ageMs >= 0 && ageMs <= recentActivityMs ? "agrees" : "does-not-agree";
};

const compareEvidence = (
  recorded: string | null,
  current: string | null
): Outcome => {
  if (!recorded?.trim() || !current?.trim()) return "unavailable";
  return recorded === current ? "agrees" : "rejects";
};

const assessRegistry = (
  { registry, currentDeviceId, originalFolderReason }: FolderHintInput,
  normalizedCwd: string | null
): Reason => {
  if (registry.state === "unavailable")
    return { code: "registry-unavailable", outcome: "rejects" };
  if (registry.state === "ambiguous")
    return { code: "registry-marker-ambiguous", outcome: "rejects" };
  if (registry.state !== "matched")
    return { code: "registry-folder-missing", outcome: "rejects" };
  if (registry.normalizedPath !== normalizedCwd)
    return { code: "registry-path-mismatch", outcome: "rejects" };
  if (
    registry.folder.originatingDeviceId !== currentDeviceId ||
    !currentDeviceId.trim()
  )
    return { code: "registry-device-mismatch", outcome: "rejects" };
  return {
    code: "live-registry-match",
    outcome: originalFolderReason === "missing" ? "agrees" : "does-not-agree"
  };
};

const assessEligibility = (input: FolderHintInput): Outcome =>
  input.effectiveFolderStatus === "unresolved" &&
  (input.originalFolderReason === "missing" ||
    input.originalFolderReason === "historical_unresolved")
    ? "agrees"
    : "rejects";

const assessMetadata = (
  state: FolderHintInput["recordedMetadataState"]
): Outcome =>
  state === "conflicting"
    ? "rejects"
    : state === "resolved"
      ? "agrees"
      : "unavailable";

/** Conditions that must hold before probing for any worktree parent. */
export const canScoreWorktreeParent = (input: FolderHintInput): boolean =>
  assessEligibility(input) === "agrees" &&
  assessMetadata(input.recordedMetadataState) !== "rejects" &&
  normalizeRecordedProjectDirectory(input.recordedCwd) !== null &&
  compareEvidence(input.originDeviceId, input.currentDeviceId) === "agrees" &&
  validTimestamp(input.firstConversationAtMs) &&
  input.firstConversationAtMs > 0 &&
  validTimestamp(input.evaluatedAtMs) &&
  input.firstConversationAtMs <= input.evaluatedAtMs;

const assessPrerequisites = (
  input: FolderHintInput,
  cwd: string | null,
  directory: FolderHintInput["directoryStat"]
): Reason[] => [
  { code: "folder-eligibility", outcome: assessEligibility(input) },
  {
    code: "recorded-metadata",
    outcome: assessMetadata(input.recordedMetadataState)
  },
  { code: "recorded-cwd", outcome: cwd ? "agrees" : "rejects" },
  { code: "local-directory", outcome: directory ? "agrees" : "rejects" }
];

const points = (outcome: Outcome, weight: number): number =>
  outcome === "agrees" ? weight : 0;

const assessDirectoryEvidence = (input: FolderHintInput) => {
  const cwd = normalizeRecordedProjectDirectory(input.recordedCwd);
  const directory =
    cwd && input.directoryStat?.isDirectory ? input.directoryStat : null;
  const origin = compareEvidence(input.originDeviceId, input.currentDeviceId);
  const birthtime = assessBirthtime(
    directory?.birthtimeMs ?? null,
    input.firstConversationAtMs,
    input.evaluatedAtMs,
    origin === "agrees"
  );
  const activity = assessActivity(
    directory?.activityMs ?? null,
    input.evaluatedAtMs
  );
  return { cwd, directory, origin, birthtime, activity };
};

const assessEvidence = (input: FolderHintInput) => {
  const { cwd, directory, origin, birthtime, activity } =
    assessDirectoryEvidence(input);
  const remote = compareEvidence(
    input.recordedRemoteFingerprint,
    input.currentRemoteFingerprint
  );
  const registry = assessRegistry(input, cwd);
  const transcript = input.hasContainedTranscriptFile
    ? "agrees"
    : "does-not-agree";
  const reasons: Reason[] = [
    ...assessPrerequisites(input, cwd, directory),
    { code: "origin-device", outcome: origin },
    { code: "directory-birthtime", outcome: birthtime },
    { code: "git-remote", outcome: remote },
    registry,
    { code: "directory-activity", outcome: activity },
    { code: "contained-transcript-file", outcome: transcript }
  ];
  const strongPoints =
    points(birthtime, 2) + points(remote, 2) + points(registry.outcome, 2);
  const score = strongPoints + points(activity, 1) + points(transcript, 1);
  return { score, strongPoints, reasons, origin, remote, birthtime };
};

export const scoreFolderHint = (input: FolderHintInput): FolderHintResult => {
  const { score, strongPoints, reasons, origin, remote, birthtime } =
    assessEvidence(input);
  if (
    input.registry.state !== "matched" ||
    reasons.some(({ outcome }) => outcome === "rejects")
  )
    return { tier: "none", score, reasons };
  if (
    score < 3 ||
    strongPoints === 0 ||
    (origin === "unavailable" && remote !== "agrees")
  )
    return { tier: "none", score, reasons };

  const folder = input.registry.folder;
  const project = input.project;
  return {
    tier:
      score >= 5 && birthtime === "agrees" && remote === "agrees"
        ? "strong"
        : "medium",
    score,
    folder,
    ...(project?.reference.ownerUserId === folder.ownerUserId
      ? { project }
      : {}),
    action: "suggestion-only",
    reasons
  };
};

export type FolderCreationResult = {
  score: number;
  reasons: readonly Reason[];
} & (
  | { tier: "none" }
  | {
      tier: "strong" | "medium";
      /** The normalized directory a new Folder would be registered for. */
      directory: string;
      action: "suggestion-only";
    }
);

/** Whether an unregistered, still-existing directory is credibly the one this
 * Conversation ran in. Read-only: it never registers the directory. */
export const scoreFolderCreation = (
  input: FolderHintInput
): FolderCreationResult => {
  const { score, reasons, origin, remote, birthtime } = assessEvidence(input);
  const cwd = normalizeRecordedProjectDirectory(input.recordedCwd);
  const adjusted = reasons.map((reason) =>
    reason.code === "registry-folder-missing"
      ? ({ code: "directory-not-registered", outcome: "agrees" } as const)
      : reason
  );
  if (
    !cwd ||
    input.registry.state !== "missing" ||
    adjusted.some(({ outcome }) => outcome === "rejects") ||
    origin !== "agrees" ||
    birthtime !== "agrees" ||
    score < 3
  )
    return { tier: "none", score, reasons: adjusted };
  return {
    tier: remote === "agrees" ? "strong" : "medium",
    score,
    directory: cwd,
    action: "suggestion-only",
    reasons: adjusted
  };
};

export type FolderWorktreeResult = {
  score: number;
  reasons: readonly Reason[];
} & (
  | { tier: "none" }
  | {
      tier: "medium";
      folder: Readonly<PersonalFolderReference>;
      action: "suggestion-only";
    }
);

/** A linked worktree has its own directory, so it never matches a registered
 * Folder. Suggest the main checkout's Folder when it is registered here, still
 * has the recorded remote, and predates the Conversation. Capped at medium. */
export const scoreWorktreeParentHint = (
  input: FolderHintInput
): FolderWorktreeResult => {
  const worktree = input.worktree;
  const cwd = normalizeRecordedProjectDirectory(input.recordedCwd);
  const reasons: Reason[] = [
    { code: "folder-eligibility", outcome: assessEligibility(input) },
    {
      code: "recorded-metadata",
      outcome: assessMetadata(input.recordedMetadataState)
    },
    { code: "recorded-cwd", outcome: cwd ? "agrees" : "rejects" },
    {
      code: "origin-device",
      outcome: compareEvidence(input.originDeviceId, input.currentDeviceId)
    }
  ];
  if (!worktree) return { tier: "none", score: 0, reasons };
  const registry = worktree.registry;
  const registered: Outcome =
    registry.state === "matched" &&
    registry.normalizedPath === worktree.rootPath &&
    registry.folder.originatingDeviceId === input.currentDeviceId
      ? "agrees"
      : "rejects";
  const remote = compareEvidence(
    input.recordedRemoteFingerprint,
    worktree.currentRemoteFingerprint
  );
  const birthtime = assessBirthtime(
    worktree.birthtimeMs,
    input.firstConversationAtMs,
    input.evaluatedAtMs,
    true
  );
  // The AI Client's own record or Git's own pointer is direct evidence of the
  // link; a path convention is only a guess and must be backed by the remote.
  const hardLink =
    worktree.link === "client-recorded" || worktree.link === "git-pointer";
  if (hardLink)
    reasons.push({
      code:
        worktree.link === "client-recorded"
          ? "worktree-link-recorded"
          : "worktree-link-git",
      outcome: "agrees"
    });
  reasons.push(
    { code: "worktree-parent-registered", outcome: registered },
    { code: "worktree-parent-remote", outcome: remote },
    { code: "worktree-parent-birthtime", outcome: birthtime }
  );
  const score =
    points(registered, 2) +
    points(remote, 2) +
    points(birthtime, 1) +
    (hardLink ? 2 : 0);
  if (
    !canScoreWorktreeParent(input) ||
    registry.state !== "matched" ||
    reasons.some(({ outcome }) => outcome === "rejects") ||
    birthtime !== "agrees" ||
    (remote !== "agrees" && !hardLink) ||
    score < 4
  )
    return { tier: "none", score, reasons };
  return {
    tier: "medium",
    score,
    folder: registry.folder,
    action: "suggestion-only",
    reasons
  };
};

export type RepositoryAnchorResult = {
  score: number;
  reasons: readonly Reason[];
} & (
  | { tier: "none" }
  | {
      tier: "medium";
      /** The portable fingerprint of the directory's current remote. It is the
       * same whether the remote is written as ssh or https. */
      repositoryKey: string;
      action: "suggestion-only";
    }
);

/** A Conversation with no recorded Git Anchor, run in a directory that still
 * exists with a portable remote. The directory's current remote is a clue to
 * the anchor, not a record of it (a remote can be re-pointed), so this is
 * capped at medium. Read-only. */
export const scoreRepositoryAnchor = (
  input: FolderHintInput,
  allowUnknownRecordingDevice = false
): RepositoryAnchorResult => {
  const {
    cwd,
    directory,
    origin,
    birthtime: localBirthtime,
    activity
  } = assessDirectoryEvidence(input);
  const reviewUnknown = allowUnknownRecordingDevice && origin === "unavailable";
  const birthtime = reviewUnknown
    ? assessBirthtime(
        directory?.birthtimeMs ?? null,
        input.firstConversationAtMs,
        input.evaluatedAtMs,
        true
      )
    : localBirthtime;
  const gitBirthtime = assessBirthtime(
    input.gitDirectoryBirthtimeMs ?? null,
    input.firstConversationAtMs,
    input.evaluatedAtMs,
    true
  );
  const current = input.currentRemoteFingerprint?.trim() || null;
  // A recorded remote that differs from today's is a conflict, not a gap.
  const recorded = input.recordedRemoteFingerprint?.trim() || null;
  const remote: Outcome = !current
    ? "unavailable"
    : recorded && recorded !== current
      ? "rejects"
      : "agrees";
  const reasons: Reason[] = [
    {
      code: "recorded-metadata",
      outcome: assessMetadata(input.recordedMetadataState)
    },
    { code: "recorded-cwd", outcome: cwd ? "agrees" : "rejects" },
    { code: "local-directory", outcome: directory ? "agrees" : "rejects" },
    { code: "origin-device", outcome: origin },
    { code: "directory-birthtime", outcome: birthtime },
    // Git directory age gates guarded inference, not advisory suggestions.
    {
      code: "git-directory-birthtime",
      outcome: gitBirthtime === "rejects" ? "does-not-agree" : gitBirthtime
    },
    { code: "directory-remote", outcome: remote },
    { code: "directory-activity", outcome: activity },
    {
      code: "contained-transcript-file",
      outcome: input.hasContainedTranscriptFile ? "agrees" : "does-not-agree"
    }
  ];
  const score =
    points(birthtime, 2) +
    points(remote, 2) +
    points(activity, 1) +
    (input.hasContainedTranscriptFile ? 1 : 0);
  // A recorded remote equal to today's means the anchor is already known.
  const anchored =
    input.gitAnchorKnown === true ||
    (recorded !== null && recorded === current);
  if (
    !current ||
    anchored ||
    reasons.some(({ outcome }) => outcome === "rejects") ||
    (origin !== "agrees" && !reviewUnknown) ||
    birthtime !== "agrees" ||
    score < 4
  )
    return { tier: "none", score, reasons };
  return {
    tier: "medium",
    score,
    repositoryKey: current,
    action: "suggestion-only",
    reasons
  };
};
