import {
  repositoryIdentitySchema,
  repositoryIdentityMatches,
  type TeamRepositorySnapshot,
  type RepositoryIdentity
} from "@koed/shared";

// Preference is applied once after semantic thresholds and stage/anchor fusion.
export const CURRENT_REPOSITORY_SCORE_BONUS = 0.04;
export const MATCHING_BRANCH_SCORE_BONUS = 0.01;
export interface RepositoryEvidenceContext {
  identity: RepositoryIdentity | null;
  label: string | null;
  branch: string | null;
}
export interface ClassifiedRepositoryEvidence {
  classification: "current" | "other" | "unknown";
  label: string | null;
  branch: string | null;
  repositoryBonus: number;
  branchBonus: number;
}
export const globalRepositoryPoolLimits = (
  limit: number,
  enabled: boolean
): { global: number; current: number } => {
  const current = enabled && limit > 1 ? Math.max(1, Math.floor(limit / 4)) : 0;
  return { global: limit - current, current };
};
export const classifyRepositoryEvidence = (
  raw: unknown,
  caller: RepositoryIdentity | null
): ClassifiedRepositoryEvidence => {
  const entries = (Array.isArray(raw) ? raw : []).map((value) => {
    const row =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const identity = repositoryIdentitySchema.safeParse(row.identity);
    return {
      identity:
        identity.success && identity.data.kind !== "unresolved"
          ? identity.data
          : null,
      label: typeof row.label === "string" ? row.label : null,
      branch: typeof row.branch === "string" ? row.branch : null
    };
  });
  const first = entries[0];
  const unknown: ClassifiedRepositoryEvidence = {
    classification: "unknown",
    label: null,
    branch: null,
    repositoryBonus: 0,
    branchBonus: 0
  };
  if (
    !first?.identity ||
    entries.some(
      (entry) =>
        !entry.identity ||
        !repositoryIdentityMatches(first.identity, entry.identity)
    )
  )
    return unknown;
  const label = first.label ?? first.identity.anchorDisplay;
  const branch =
    first.branch && entries.every((entry) => entry.branch === first.branch)
      ? first.branch
      : null;
  if (!caller || caller.kind === "unresolved")
    return { ...unknown, label, branch };
  if (
    (caller.kind !== "portable_repository" ||
      first.identity.kind !== "portable_repository") &&
    first.identity.originatingDeviceId !== caller.originatingDeviceId
  )
    return { ...unknown, label, branch };
  const current = repositoryIdentityMatches(first.identity, caller);
  return {
    classification: current ? "current" : "other",
    label,
    branch,
    repositoryBonus: current ? CURRENT_REPOSITORY_SCORE_BONUS : 0,
    branchBonus:
      current && branch !== null && branch === caller.branch
        ? MATCHING_BRANCH_SCORE_BONUS
        : 0
  };
};
export const canonicalGlobalCandidateKey = (row: {
  source_type: string;
  source_id: string;
  source_chunk_index?: number | null;
  source_chunk_count?: number | null;
  source_generation?: number | null;
  visibility: string;
}): string =>
  JSON.stringify([
    row.visibility,
    row.source_type,
    row.source_id,
    row.source_chunk_index ?? 0,
    row.source_chunk_count ?? 1,
    row.source_generation ?? null
  ]);

// Team provenance comes exclusively from the authorized, frozen Share Grant.
// A branch is comparable only when the disclosed representation agrees with it.
export const classifyTeamRepositoryEvidence = (
  snapshot: TeamRepositorySnapshot,
  disclosed: TeamRepositorySnapshot | undefined,
  caller: RepositoryIdentity | null
): ClassifiedRepositoryEvidence => {
  const identity: RepositoryIdentity | null =
    snapshot.classification === "portable_repository"
      ? {
          kind: "portable_repository",
          key: snapshot.fingerprint,
          root: null,
          branch: null,
          reason: "origin",
          checkoutId: null,
          originatingDeviceId: "team_snapshot",
          selectedRemote: null,
          anchorDisplay: snapshot.label
        }
      : null;
  return classifyRepositoryEvidence(
    [
      {
        identity,
        label: snapshot.label,
        branch:
          disclosed?.classification === "portable_repository" &&
          disclosed.fingerprint === snapshot.fingerprint &&
          disclosed.branchObservation === snapshot.branchObservation
            ? snapshot.branchObservation
            : null
      }
    ],
    caller?.kind === "portable_repository" ? caller : null
  );
};
