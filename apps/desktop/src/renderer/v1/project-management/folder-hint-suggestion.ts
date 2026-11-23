import type {
  PersonalFolderHint,
  PersonalFolderReference
} from "@koed-labs/shared";
import { personalFolderScopeId } from "@koed-labs/shared/personal-desktop";

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

export type ProposalProject = { id: string; name: string };

export type FolderProposal = {
  tier: "medium" | "strong";
  /** The directory involved, for the label and tooltip. */
  directory?: string;
  /** Projects this would land the Conversation in, so the User sees them. */
  projects: ProposalProject[];
  /** Agreeing evidence codes, strongest first; worded in the `?` tooltip. */
  evidence: EvidenceCode[];
} & (
  | {
      action: "use";
      kind: "registered" | "worktree-parent";
      folder: PersonalFolderReference;
    }
  | {
      action: "anchor";
      kind: "repository";
      repositoryKey: string;
      gitRevision?: number;
      recordingDeviceUnknown?: true;
    }
);

export const proposalProjectLabel = (proposal: FolderProposal): string =>
  [...new Set(proposal.projects.map(({ name }) => name))].join(", ");

export function suggestionApprovalKey(
  projectId: string,
  { sessionId, proposal }: { sessionId: string; proposal: FolderProposal }
): string {
  return JSON.stringify([
    projectId,
    sessionId,
    proposal.kind,
    proposal.kind === "repository"
      ? proposal.recordingDeviceUnknown
        ? [
            proposal.repositoryKey,
            proposal.directory,
            "unknown-recording-device"
          ]
        : proposal.repositoryKey
      : personalFolderScopeId(proposal.folder)
  ]);
}

const rank = {
  "worktree-parent": 0,
  registered: 1,
  repository: 2
} as const;

export type ProposalResolvers = {
  /** Projects an existing Folder is already in. */
  folder?: (folder: PersonalFolderReference) => ProposalProject[];
  /** Projects a Git Anchor key is already in; empty if none can be set. */
  repository?: (key: string) => ProposalProject[];
  /** Only Project Suggestions have the guarded unknown-device review flow. */
  reviewBatch?: boolean;
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
        const { repositoryKey, gitRevision, recordingDeviceProvenance } = hint;
        if (
          !repositoryKey ||
          (resolve.reviewBatch && recordingDeviceProvenance === "known-copy")
        )
          return [];
        const recordingDeviceUnknown = recordingDeviceProvenance === "unknown";
        if (
          recordingDeviceUnknown &&
          (!resolve.reviewBatch ||
            hint.gitInferenceEligibility !== true ||
            gitRevision !== 1 ||
            !hint.directory)
        )
          return [];
        const projects = resolve.repository?.(repositoryKey) ?? [];
        return projects.length
          ? [
              {
                ...details,
                action: "anchor",
                kind,
                repositoryKey,
                gitRevision,
                ...(recordingDeviceUnknown
                  ? { recordingDeviceUnknown: true }
                  : {}),
                projects
              }
            ]
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
