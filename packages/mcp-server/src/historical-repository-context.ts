import { resolveCaptureRepositoryIdentity } from "./capture-repository-context.js";
import path from "node:path";
import {
  isPortableGitRemote,
  normalizeGitRemoteUrl,
  type RepositoryIdentity
} from "@koed/shared";

// Historical sources may not establish a device-local identity from a path.
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
      !(path.isAbsolute(metadata.cwd) || path.win32.isAbsolute(metadata.cwd)) ||
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

// Current discovery checks eligibility only; it never supplies historical identity.
export const resolveHistoricalCaptureRepositoryIdentity = async (input: {
  sourceTime: RepositoryIdentity | null;
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
}): Promise<RepositoryIdentity> => {
  if (
    !input.sourceTime ||
    input.sourceTime.kind !== "portable_repository" ||
    !input.cwd
  )
    return unresolvedHistoricalRepositoryIdentity();
  const current = await resolveCaptureRepositoryIdentity({
    cwd: input.cwd,
    env: input.env
  });
  return current?.kind === "portable_repository" &&
    current.key === input.sourceTime.key
    ? input.sourceTime
    : unresolvedHistoricalRepositoryIdentity();
};
