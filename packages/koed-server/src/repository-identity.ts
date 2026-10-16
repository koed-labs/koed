import {
  hmacProjectValue,
  isPortableGitRemote,
  type AssociatedRepositorySelection,
  type RepositoryIdentity
} from "@koed/shared";
import type { GitProjectProbeResult } from "./git-project-probe.js";

export const resolveRepositoryIdentity = (input: {
  observation: GitProjectProbeResult;
  cwd: string;
  deviceSalt: string;
  checkoutId: string | null;
  localSelection?: string;
  associatedSelection?: AssociatedRepositorySelection;
  commonDirMarker?: string | null;
}): RepositoryIdentity => {
  const { observation, deviceSalt, checkoutId } = input;
  const base = {
    root: observation.root ?? input.cwd,
    branch: observation.branch,
    checkoutId,
    originatingDeviceId: deviceSalt,
    selectedRemote: null,
    anchorDisplay: null
  };
  const unresolved = (
    reason: RepositoryIdentity["reason"],
    selectedRemote: string | null = null
  ): RepositoryIdentity => ({
    ...base,
    kind: "unresolved",
    key: null,
    reason,
    selectedRemote
  });
  if (
    observation.status === "failed" &&
    (!observation.root ||
      observation.failedCommands.some(
        (command) =>
          !["branch --show-current", "rev-parse HEAD"].includes(command)
      ))
  )
    return unresolved("probe_failed");
  if (observation.status === "ambiguous") return unresolved("probe_ambiguous");
  if (!checkoutId) return unresolved("checkout_unavailable");
  const selected = (
    remoteName: string,
    reason: RepositoryIdentity["reason"]
  ): RepositoryIdentity => {
    const candidates = observation.remotes.filter(
      (remote) => remote.name === remoteName
    );
    if (!candidates.length) return unresolved("selection_missing", remoteName);
    const keys = new Set(candidates.map((remote) => remote.fingerprint));
    if (keys.size !== 1) return unresolved("selection_conflict", remoteName);
    const remote = candidates[0]!;
    if (!isPortableGitRemote(remote))
      return unresolved("selection_not_portable", remoteName);
    return {
      ...base,
      kind: "portable_repository",
      key: remote.fingerprint,
      reason,
      selectedRemote: remoteName,
      anchorDisplay: remote.display
    };
  };
  if (input.localSelection !== undefined)
    return selected(input.localSelection, "local_selection");
  if (input.associatedSelection) {
    const { selection } = input.associatedSelection;
    if (selection.state === "conflict") return unresolved("selection_conflict");
    const remote = observation.remotes.find(
      (entry) =>
        isPortableGitRemote(entry) &&
        entry.fingerprint === selection.anchorFingerprint
    );
    if (!remote) return unresolved("replicated_anchor_missing");
    return selected(remote.name, "replicated_selection");
  }
  if (observation.status === "non_git") {
    return {
      ...base,
      kind: "non_git_project",
      key: `ng_${hmacProjectValue(deviceSalt, `${input.cwd}\n${checkoutId}`).slice(12)}`,
      reason: "non_git"
    };
  }
  for (const remoteName of ["upstream", "origin"] as const) {
    const remotes = observation.remotes.filter(
      (remote) => remote.name === remoteName
    );
    // A conflicting selected default is unresolved; extra remotes never rescue it.
    if (remotes.some(isPortableGitRemote))
      return selected(remoteName, remoteName);
  }
  if (!observation.commonDir || !input.commonDirMarker)
    return unresolved("probe_failed");
  return {
    ...base,
    kind: "device_local_repository",
    key: `dl_${hmacProjectValue(deviceSalt, `${observation.commonDir}\n${input.commonDirMarker}`).slice(12)}`,
    reason: "local_fallback"
  };
};
