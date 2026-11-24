import {
  hmacProjectValue,
  isPortableGitRemote,
  normalizeGitRemoteUrl,
  type AssociatedRepositorySelection,
  type NormalizedGitRemote,
  type RepositoryIdentity
} from "@koed-labs/shared";
import type {
  GitProjectProbeResult,
  readSelectedGitRemoteUrls
} from "./git-project-probe.js";

export type SelectedGitRemoteUrls = Awaited<
  ReturnType<typeof readSelectedGitRemoteUrls>
>;

type RemoteResolution =
  | {
      state: "selected";
      remote: NormalizedGitRemote;
      reason:
        | "local_selection"
        | "replicated_selection"
        | "upstream"
        | "origin";
    }
  | {
      state: "unresolved";
      reason:
        | "selection_missing"
        | "selection_conflict"
        | "selection_not_portable"
        | "replicated_anchor_missing";
      remoteName?: string;
    }
  | { state: "none" };

const selectNamedRemote = (
  remotes: readonly NormalizedGitRemote[],
  remoteName: string,
  reason: Extract<RemoteResolution, { state: "selected" }>["reason"]
): RemoteResolution => {
  const candidates = remotes.filter((remote) => remote.name === remoteName);
  const remote = candidates[0];
  if (!remote)
    return { state: "unresolved", reason: "selection_missing", remoteName };
  if (new Set(candidates.map((entry) => entry.fingerprint)).size !== 1)
    return { state: "unresolved", reason: "selection_conflict", remoteName };
  if (!isPortableGitRemote(remote))
    return {
      state: "unresolved",
      reason: "selection_not_portable",
      remoteName
    };
  return { state: "selected", remote, reason };
};

/** Shared selection policy; callers supply fresh, validated Git observations. */
export const resolveRepositoryRemote = (input: {
  observation: Pick<GitProjectProbeResult, "status" | "remotes">;
  localSelection?: string;
  associatedSelection?: AssociatedRepositorySelection;
}): RemoteResolution => {
  const { observation, localSelection, associatedSelection } = input;
  const { remotes } = observation;
  if (localSelection !== undefined)
    return selectNamedRemote(remotes, localSelection, "local_selection");
  if (associatedSelection) {
    const { selection } = associatedSelection;
    if (selection.state === "conflict")
      return { state: "unresolved", reason: "selection_conflict" };
    const remote = remotes.find(
      (entry) =>
        isPortableGitRemote(entry) &&
        entry.fingerprint === selection.anchorFingerprint
    );
    return remote
      ? selectNamedRemote(remotes, remote.name, "replicated_selection")
      : { state: "unresolved", reason: "replicated_anchor_missing" };
  }
  if (observation.status !== "non_git") {
    for (const name of ["upstream", "origin"] as const) {
      // A conflicting selected default is unresolved; extra remotes never rescue it.
      if (
        remotes.some(
          (remote) => remote.name === name && isPortableGitRemote(remote)
        )
      )
        return selectNamedRemote(remotes, name, name);
    }
  }
  return { state: "none" };
};

export const validateSelectedRepositoryRemote = (
  remote: NormalizedGitRemote,
  urls: SelectedGitRemoteUrls | null
): "probe_failed" | "selection_conflict" | null => {
  if (urls?.name !== remote.name || !urls.fetch || !urls.push)
    return "probe_failed";
  const remotes = [
    remote,
    ...[urls.fetch, urls.push].flatMap((output) =>
      output.split("\n").map((url) => normalizeGitRemoteUrl(url, remote.name))
    )
  ];
  return selectNamedRemote(remotes, remote.name, "local_selection").state ===
    "selected"
    ? null
    : "selection_conflict";
};

export const resolveRepositoryIdentity = (input: {
  observation: GitProjectProbeResult;
  cwd: string;
  deviceSalt: string;
  checkoutId: string | null;
  localSelection?: string;
  associatedSelection?: AssociatedRepositorySelection;
  commonDirMarker?: string | null;
  selectedRemoteUrls?: SelectedGitRemoteUrls | null;
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
  const selection = resolveRepositoryRemote(input);
  if (selection.state === "unresolved")
    return unresolved(selection.reason, selection.remoteName);
  if (selection.state === "selected") {
    if (input.selectedRemoteUrls !== undefined) {
      const failure = validateSelectedRepositoryRemote(
        selection.remote,
        input.selectedRemoteUrls
      );
      if (failure) return unresolved(failure, selection.remote.name);
    }
    return {
      ...base,
      kind: "portable_repository",
      key: selection.remote.fingerprint,
      reason: selection.reason,
      selectedRemote: selection.remote.name,
      anchorDisplay: selection.remote.display
    };
  }
  if (observation.status === "non_git") {
    return {
      ...base,
      kind: "non_git_project",
      key: `ng_${hmacProjectValue(deviceSalt, `${input.cwd}\n${checkoutId}`).slice(12)}`,
      reason: "non_git"
    };
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
