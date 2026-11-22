import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import {
  organizationEdit,
  reviewConversationOrganization
} from "./conversation-organization.js";
import { reviewSourceCorrections } from "./correction-review.js";
import { repositoryTargetFor } from "./repository-project.js";
import type { SuggestionRow } from "./use-folder-suggestions.js";
import { projectErrorMessage } from "./use-organization-review.js";

/** Accept one suggestion as the single-conversation dialog does: make the
 * Folder known, review the correction against the Conversation's current
 * state, then save it as an ordinary version-pinned edit. The Conversation
 * then joins through the Project's own Folder or Git Anchor rule. */
export async function applySuggestion(
  api: PersonalDesktopApi,
  projects: readonly DesktopProject[],
  row: SuggestionRow
): Promise<void> {
  const { proposal } = row;
  // A Git Anchor a Project already uses needs no device-side step; a Folder is
  // made known to this Conversation first.
  const anchor =
    proposal.kind === "repository" && proposal.repositoryKey
      ? repositoryTargetFor(projects, proposal.repositoryKey)
      : undefined;
  if (proposal.kind === "repository" && !anchor)
    throw new Error("That Git Anchor is no longer available.");
  if (!api.manageSourceContext || (!anchor && !api.createHintedFolder))
    throw new Error("Suggestions cannot be added here.");
  const accepted = anchor
    ? undefined
    : await api.createHintedFolder!({
        sessionId: row.sessionId,
        kind: proposal.kind as "registered" | "worktree-parent" | "create"
      });
  const review = await reviewConversationOrganization(
    api,
    projects,
    row.sessionId
  );
  const reviewed = await reviewSourceCorrections(api, review, [
    anchor
      ? {
          axis: "git",
          action: "set",
          repository: anchor.repository,
          expectedVersion: review.context.git.revision
        }
      : {
          axis: "folder",
          action: "set",
          folder: accepted!.folder,
          expectedVersion: review.context.folder.revision
        }
  ]);
  await api.manageSourceContext({
    action: "organize",
    sessionId: row.sessionId,
    edit: organizationEdit(review, [], reviewed.corrections)
  });
}

/** Apply each suggestion in turn; one failure does not stop the rest. */
export async function applySuggestions(
  api: PersonalDesktopApi,
  projects: readonly DesktopProject[],
  rows: readonly SuggestionRow[]
): Promise<{ done: number; failed: string[] }> {
  const failed: string[] = [];
  let done = 0;
  for (const row of rows) {
    try {
      await applySuggestion(api, projects, row);
      done += 1;
    } catch (cause) {
      failed.push(`${row.title}: ${projectErrorMessage(cause)}`);
    }
  }
  return { done, failed };
}
