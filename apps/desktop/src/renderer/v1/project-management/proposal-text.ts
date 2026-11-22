import { folderLabel } from "./folder-label.js";
import type { EvidenceCode, FolderProposal } from "./folder-hint-suggestion.js";

/** `~` for the home folder, and the middle of a long path cut out, so a path
 * fits on one tooltip line. Display only. */
export function shortPath(path: string, max = 44): string {
  const home = path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
  if (home.length <= max) return home;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${home.slice(0, max - 1 - tail)}…${home.slice(-tail)}`;
}

/** A few words on where the suggestion comes from, for the row. */
export function suggestionReason(proposal: FolderProposal): string {
  const name = proposal.directory
    ? folderLabel(proposal.directory).name
    : undefined;
  switch (proposal.kind) {
    case "worktree-parent":
      return name ? `Worktree of ${name}` : "Worktree of the main checkout";
    case "repository":
      return "Git Anchor match";
    default:
      return "Folder match";
  }
}

/** The tooltip's first line: the row's reason, with what it points at. */
export function proposalLead(proposal: FolderProposal): string {
  const path = proposal.directory ? shortPath(proposal.directory) : undefined;
  switch (proposal.kind) {
    case "repository":
      return proposal.projects.length > 0
        ? `Same Git remote as ${proposal.projects.join(", ")}`
        : "Same Git remote";
    case "registered":
      return path ? `Recorded in ${path}` : "Recorded Folder";
    default:
      return suggestionReason(proposal);
  }
}

export type EvidenceLine = {
  text: string;
  /** A path or Git Anchor, shown quieter after the text. */
  detail?: string;
};

/** One short line per piece of agreeing evidence. `anchor` is the Git
 * Anchor's display name and `client` the AI Client's name, when known. */
export function evidenceLines(
  proposal: FolderProposal,
  { anchor, client }: { anchor?: string; client?: string } = {}
): EvidenceLine[] {
  const here = proposal.directory ? shortPath(proposal.directory) : undefined;
  const at = (text: string): EvidenceLine =>
    here ? { text, detail: here } : { text };
  const line: Record<EvidenceCode, EvidenceLine> = {
    "worktree-link-recorded": at(
      `${client ?? "The AI Client"} recorded it as a worktree of`
    ),
    "worktree-link-git": at("Git lists it as a worktree of"),
    "git-remote": { text: "Still has the Git remote it had then" },
    "worktree-parent-remote": { text: "Main checkout has the same Git remote" },
    "directory-remote": here
      ? { text: here, detail: `→ ${anchor ?? "the same Git remote"}` }
      : {
          text: "Uses the same Git remote",
          ...(anchor ? { detail: anchor } : {})
        },
    "live-registry-match": { text: "A later capture registered this folder" },
    "worktree-parent-registered": at("Already a Folder:"),
    "directory-birthtime": {
      text: "Folder existed before this conversation"
    },
    "worktree-parent-birthtime": {
      text: "Main checkout existed before this conversation"
    },
    "contained-transcript-file": {
      text: "A file from this conversation is still there"
    },
    "directory-activity": { text: "Recent activity in the folder" }
  };
  return proposal.evidence.map((code) => line[code]);
}
