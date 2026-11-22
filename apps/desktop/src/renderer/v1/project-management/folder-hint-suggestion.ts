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
  tier: "medium" | "strong";
  /** The directory involved, for the label and tooltip. */
  directory?: string;
  /** Projects this would land the Conversation in, so the User sees them. */
  projects: string[];
  /** Agreeing evidence codes, strongest first; worded in the `?` tooltip. */
  evidence: EvidenceCode[];
} & (
  | {
      action: "use";
      kind: "registered" | "worktree-parent";
      folder: PersonalFolderReference;
    }
  | { action: "anchor"; kind: "repository"; repositoryKey: string }
);

const rank = {
  "worktree-parent": 0,
  registered: 1,
  repository: 2
} as const;

export type ProposalResolvers = {
  /** Project names an existing Folder is already in. */
  folder?: (folder: PersonalFolderReference) => string[];
  /** Project names a Git Anchor key is already in; empty if none can be set. */
  repository?: (key: string) => string[];
};

/** One advisory proposal. A candidate that lands the Conversation in a Project
 * wins; then a linked worktree's main checkout, an existing Folder, the Git
 * Anchor of the directory's remote. Unregistered directories and Git Anchors
 * no Project uses have nothing to select. */
export function folderProposal(
  hints: readonly PersonalFolderHint[],
  resolve: ProposalResolvers = {}
): FolderProposal | undefined {
  return hints
    .flatMap((hint): FolderProposal[] => {
      if (hint.tier === "none" || hint.kind === "create") return [];
      const kind = hint.kind ?? "registered";
      const details = {
        tier: hint.tier,
        ...(hint.directory ? { directory: hint.directory } : {}),
        evidence: agreeing(hint)
      };
      if (kind === "repository") {
        const { repositoryKey } = hint;
        if (!repositoryKey) return [];
        const projects = resolve.repository?.(repositoryKey) ?? [];
        return projects.length
          ? [{ ...details, action: "anchor", kind, repositoryKey, projects }]
          : [];
      }
      return hint.folder
        ? [
            {
              ...details,
              action: "use",
              kind,
              folder: hint.folder,
              projects: resolve.folder?.(hint.folder) ?? []
            }
          ]
        : [];
    })
    .sort(
      (a, b) =>
        Number(b.projects.length > 0) - Number(a.projects.length > 0) ||
        rank[a.kind] - rank[b.kind]
    )[0];
}
