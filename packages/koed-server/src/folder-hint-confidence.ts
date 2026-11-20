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
  | Readonly<{ state: "ambiguous" }>;
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
  /** A match confirms the current directory marker. */
  readonly registry: RegistryLookup;
  /** The caller verifies existence and strict containment on disk. */
  readonly hasContainedTranscriptFile: boolean;
  /** The caller establishes this Project's existing rule for the candidate Folder. */
  readonly project?: ProjectContext;
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
    | "git-remote"
    | "live-registry-match"
    | "registry-marker-ambiguous"
    | "registry-folder-missing"
    | "registry-path-mismatch"
    | "registry-device-mismatch"
    | "directory-activity"
    | "contained-transcript-file";
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
  sameDevice: boolean
): Outcome => {
  if (
    !validTimestamp(birthtimeMs) ||
    birthtimeMs === 0 ||
    !validTimestamp(firstConversationAtMs)
  )
    return "unavailable";
  if (birthtimeMs > firstConversationAtMs) return "rejects";
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

const assessEvidence = (input: FolderHintInput) => {
  const cwd = normalizeRecordedProjectDirectory(input.recordedCwd);
  const directory =
    cwd && input.directoryStat?.isDirectory ? input.directoryStat : null;
  const origin = compareEvidence(input.originDeviceId, input.currentDeviceId);
  const birthtime = assessBirthtime(
    directory?.birthtimeMs ?? null,
    input.firstConversationAtMs,
    origin === "agrees"
  );
  const remote = compareEvidence(
    input.recordedRemoteFingerprint,
    input.currentRemoteFingerprint
  );
  const registry = assessRegistry(input, cwd);
  const activity = assessActivity(
    directory?.activityMs ?? null,
    input.evaluatedAtMs
  );
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
