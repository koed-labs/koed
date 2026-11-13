import {
  readSourceRepositoryIdentity,
  resolveKoedServerPaths
} from "@koed-labs/server";
import {
  isPortableGitRemote,
  normalizeGitRemoteUrl,
  normalizeRecordedProjectDirectory,
  type RepositoryIdentity
} from "@koed-labs/shared";

// Missing or ambiguous source context never inherits the importing process's cwd.
export const unresolvedHistoricalRepositoryIdentity =
  (): RepositoryIdentity => ({
    kind: "unresolved",
    key: null,
    root: null,
    branch: null,
    reason: "probe_ambiguous",
    checkoutId: null,
    originatingDeviceId: "historical_unknown_device",
    selectedRemote: null,
    anchorDisplay: null
  });
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Only native source-time Session metadata can supply a historical anchor. */
export const codexSourceTimeRepositoryIdentity = (
  records: unknown[]
): RepositoryIdentity | null => {
  const observations = records.flatMap((value) => {
    const envelope = record(value);
    if (envelope?.type !== "session_meta") return [];
    const metadata = record(envelope.payload) ?? envelope;
    const git = record(metadata.git);
    if (
      typeof metadata.cwd !== "string" ||
      !normalizeRecordedProjectDirectory(metadata.cwd) ||
      typeof metadata.timestamp !== "string" ||
      !Number.isFinite(Date.parse(metadata.timestamp)) ||
      typeof git?.repository_url !== "string"
    )
      return [null];
    const remote = normalizeGitRemoteUrl(git.repository_url);
    if (!isPortableGitRemote(remote)) return [null];
    return [
      {
        ...unresolvedHistoricalRepositoryIdentity(),
        kind: "portable_repository" as const,
        key: remote.fingerprint,
        reason: "origin" as const,
        selectedRemote: "origin",
        anchorDisplay: remote.display,
        branch:
          typeof git.branch === "string" &&
          git.branch.length > 0 &&
          git.branch.length <= 512
            ? git.branch
            : null
      }
    ];
  });
  const first = observations[0];
  if (!first || observations.some((value) => !value || value.key !== first.key))
    return null;
  return {
    ...first,
    branch: observations.every((value) => value?.branch === first.branch)
      ? first.branch
      : null
  };
};

/** Only consistent native Session metadata can supply a historical folder. */
export const codexSourceTimeProjectDirectory = (
  records: unknown[]
): string | null => {
  const metadata = records.flatMap((value) => {
    const envelope = record(value);
    return envelope?.type === "session_meta"
      ? [record(envelope.payload) ?? envelope]
      : [];
  });
  const directories = metadata.map((value) =>
    normalizeRecordedProjectDirectory(value.cwd)
  );
  const anchors = metadata.flatMap((value) => {
    const url = record(value.git)?.repository_url;
    if (typeof url !== "string") return [];
    return [normalizeGitRemoteUrl(url).fingerprint];
  });
  const first = directories[0];
  return first &&
    directories.every((value) => value === first) &&
    new Set(anchors).size <= 1
    ? first
    : null;
};

// The DB retains assignments and explicit corrections. Never infer source facts
// from today's path: this resolver applies equally to delayed live capture.
export const resolveHistoricalCaptureRepositoryIdentity = (input: {
  sourceTime: RepositoryIdentity | null;
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  source?: {
    sourceKind: "codex" | "claude-code" | "pi";
    externalSessionId: string;
  };
}): Promise<RepositoryIdentity> => {
  let pinned: RepositoryIdentity | undefined;
  if (input.source) {
    pinned = readSourceRepositoryIdentity(
      resolveKoedServerPaths(input.env),
      input.source
    );
    // Preserve explicit selections and unresolved selections alike. Native origin
    // metadata cannot override a source-time selected upstream/custom remote.
    if (
      pinned &&
      (pinned.kind !== "unresolved" ||
        !["probe_failed", "probe_ambiguous", "checkout_unavailable"].includes(
          pinned.reason
        ))
    )
      return Promise.resolve(pinned);
  }
  if (input.sourceTime?.kind === "portable_repository")
    return Promise.resolve(input.sourceTime);
  return Promise.resolve(pinned ?? unresolvedHistoricalRepositoryIdentity());
};
