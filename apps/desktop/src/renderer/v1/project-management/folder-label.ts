const CLAUDE_WORKTREE = /^(.*)\/\.claude\/worktrees\/([^/]+)/;

const lastSegment = (path: string): string =>
  path.split("/").filter(Boolean).pop() ?? path;

export type FolderLabel = {
  /** What to call the Folder: the project it belongs to, not a task's worktree. */
  name: string;
  /** Secondary context, such as the worktree an agent made for one task. */
  detail?: string;
};

/** A display label only. A worktree is still its own Folder; this never
 * decides identity or assignment. Only the Claude Code worktree layout is
 * recognised, because that is the only layout whose path names its parent. */
export function folderLabel(path: string): FolderLabel {
  const worktree = CLAUDE_WORKTREE.exec(path);
  return worktree?.[1] && worktree[2]
    ? { name: lastSegment(worktree[1]), detail: `worktree ${worktree[2]}` }
    : { name: lastSegment(path) };
}

export function folderLabelText(path: string): string {
  const { name, detail } = folderLabel(path);
  return detail ? `${name} · ${detail}` : name;
}

/** `detail` on a Folder source is "<path> · <device id>". Drop the device. */
export function folderSourceLabel(detail: string): string {
  const path = detail.split(" · ")[0] ?? detail;
  return path.startsWith("/") ? folderLabelText(path) : detail;
}
