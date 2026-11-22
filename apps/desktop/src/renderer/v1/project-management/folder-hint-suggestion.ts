import type {
  PersonalFolderHint,
  PersonalFolderReference
} from "@koed-labs/shared";

/** Agreeing evidence, strongest first. The last two are weak on their own and
 * are shown only when nothing stronger agrees. */
export const EVIDENCE_ORDER = [
  "worktree-link-recorded",
  "worktree-link-git",
  "git-remote",
  "worktree-parent-remote",
  "directory-remote",
  "live-registry-match",
  "worktree-parent-registered",
  "directory-not-registered",
  "directory-birthtime",
  "worktree-parent-birthtime",
  "contained-transcript-file",
  "directory-activity"
] as const;
export type EvidenceCode = (typeof EVIDENCE_ORDER)[number];
const WEAK: ReadonlySet<string> = new Set([
  "contained-transcript-file",
  "directory-activity"
]);

const agreeing = (hint: PersonalFolderHint): EvidenceCode[] => {
  const codes = EVIDENCE_ORDER.filter((code) =>
    hint.reasons.some(
      (reason) => reason.code === code && reason.outcome === "agrees"
    )
  );
  const strong = codes.filter((code) => !WEAK.has(code));
  return strong.length > 0 ? strong : codes;
};

export type FolderProposal = {
  /** Use a Folder this device already knows, register a new one first, or use
   * the Git Anchor of the directory's remote. */
  action: "use" | "create" | "anchor";
  kind: "registered" | "worktree-parent" | "create" | "repository";
  tier: "medium" | "strong";
  /** The directory involved, for the label and tooltip. */
  directory?: string;
  /** The portable key of the Git Anchor, for a repository proposal. */
  repositoryKey?: string;
  /** Projects this would land the Conversation in, so the User sees them. */
  projects: string[];
  /** Agreeing evidence codes, strongest first; worded in the `?` tooltip. */
  evidence: EvidenceCode[];
};

const rank = {
  "worktree-parent": 0,
  registered: 1,
  repository: 2,
  create: 3
} as const;

export type ProposalResolvers = {
  /** Project names an existing Folder is already in. */
  folder?: (folder: PersonalFolderReference) => string[];
  /** Project names a Git Anchor key is already in; empty if none can be set. */
  repository?: (key: string) => string[];
};

/** One advisory proposal. A candidate that lands the Conversation in a Project
 * wins; then a linked worktree's main checkout, an existing Folder, the Git
 * Anchor of the directory's remote, and a new Folder. A Git Anchor nothing uses
 * is dropped, since there is nothing to select. The User accepts it explicitly
 * and still reviews the correction before saving. */
export function folderProposal(
  hints: readonly PersonalFolderHint[],
  resolve: ProposalResolvers = {}
): FolderProposal | undefined {
  type Candidate = {
    hint: PersonalFolderHint;
    kind: FolderProposal["kind"];
    projects: string[];
  };
  const candidates = hints
    .flatMap((hint): Candidate[] => {
      if (hint.tier === "none") return [];
      const kind = hint.kind ?? "registered";
      if (kind === "repository") {
        const projects = hint.repositoryKey
          ? (resolve.repository?.(hint.repositoryKey) ?? [])
          : [];
        return projects.length > 0 ? [{ hint, kind, projects }] : [];
      }
      if (kind === "create")
        return hint.directory ? [{ hint, kind, projects: [] }] : [];
      return hint.folder
        ? [{ hint, kind, projects: resolve.folder?.(hint.folder) ?? [] }]
        : [];
    })
    .sort(
      (a, b) =>
        Number(b.projects.length > 0) - Number(a.projects.length > 0) ||
        rank[a.kind] - rank[b.kind]
    );
  const best = candidates[0];
  if (!best || best.hint.tier === "none") return undefined;
  return {
    action:
      best.kind === "create"
        ? "create"
        : best.kind === "repository"
          ? "anchor"
          : "use",
    kind: best.kind,
    tier: best.hint.tier,
    ...(best.hint.directory ? { directory: best.hint.directory } : {}),
    ...(best.hint.repositoryKey
      ? { repositoryKey: best.hint.repositoryKey }
      : {}),
    projects: best.projects,
    evidence: agreeing(best.hint)
  };
}
