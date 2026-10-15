import {
  historicalFolderRepositoryIdentity,
  resolveKoedServerPaths
} from "@koed-labs/server";
import path from "node:path";
import { resolveCaptureRepositoryIdentity } from "./capture-repository-context.js";
import {
  isPortableGitRemote,
  normalizeGitRemoteUrl,
  normalizeRecordedProjectDirectory,
  type RepositoryIdentity
} from "@koed/shared";

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

// The DB retains existing assignments. Discovery applies only to fresh imports.
export const resolveHistoricalCaptureRepositoryIdentity = async (input: {
  sourceTime: RepositoryIdentity | null;
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
}): Promise<RepositoryIdentity> => {
  if (input.sourceTime?.kind === "portable_repository") return input.sourceTime;
  const cwd = normalizeRecordedProjectDirectory(input.cwd);
  if (!cwd) return unresolvedHistoricalRepositoryIdentity();
  // A foreign recorded path must never resolve relative to this process's cwd.
  if (
    path.isAbsolute(cwd) &&
    (process.platform !== "win32" || path.parse(cwd).root.length > 1)
  ) {
    const current = await resolveCaptureRepositoryIdentity({
      cwd,
      env: input.env
    });
    if (
      current?.kind === "portable_repository" ||
      current?.kind === "device_local_repository" ||
      (current?.kind === "unresolved" &&
        !["probe_failed", "checkout_unavailable"].includes(current.reason))
    ) {
      // This is today's repository identity, not evidence of a historical branch.
      return { ...current, branch: null };
    }
  }
  return (
    historicalFolderRepositoryIdentity(
      resolveKoedServerPaths(input.env),
      cwd
    ) ?? unresolvedHistoricalRepositoryIdentity()
  );
};
