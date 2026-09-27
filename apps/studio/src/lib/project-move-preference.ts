const PROJECT_MOVE_NOTICE_DISMISSED_KEY =
  "koed.studio.project-move-notice-dismissed";

/** Returns whether this Studio installation has dismissed the Project move notice. */
export function hasDismissedProjectMoveNotice(): boolean {
  if (typeof window === "undefined") return false;

  try {
    return (
      window.localStorage.getItem(PROJECT_MOVE_NOTICE_DISMISSED_KEY) === "true"
    );
  } catch {
    return false;
  }
}

/** Hides only the Project instructions explanation; source-edits still require confirmation. */
export function shouldShowProjectMoveInstructionsNotice(): boolean {
  return !hasDismissedProjectMoveNotice();
}

/** A notice intent is valid only after Koed accepts a move request. */
export function shouldKeepProjectMoveNoticeIntent(
  state: "pending" | "claimed" | "completed" | "cancelled" | "failed"
): boolean {
  return state === "pending" || state === "claimed" || state === "completed";
}

/** A possible source-edits warning remains visible after dismissing the general explanation. */
export function shouldConfirmProjectMove(
  sourceEditStatus: "changed" | "clean" | "unknown"
): boolean {
  return sourceEditStatus !== "clean" || !hasDismissedProjectMoveNotice();
}

/** Stores the choice locally so the notice stays dismissed on this Studio installation. */
export function dismissProjectMoveNotice(): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(PROJECT_MOVE_NOTICE_DISMISSED_KEY, "true");
  } catch {
    // The move should still work when browser storage is unavailable.
  }
}
