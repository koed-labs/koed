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

async function applySuggestion(
  api: PersonalDesktopApi,
  projects: readonly DesktopProject[],
  row: SuggestionRow,
  destinationProjectId: string,
  check: () => void
): Promise<void> {
  const { proposal, sessionId } = row;
  if (!api.manageSourceContext)
    throw new Error("Suggestions cannot be added here.");
  const anchor =
    proposal.kind === "repository"
      ? repositoryTargetFor(projects, proposal.repositoryKey)
      : undefined;
  if (proposal.kind === "repository") {
    if (!anchor) throw new Error("That Git Anchor is no longer available.");
  } else {
    if (!api.confirmFolderHint)
      throw new Error("Folder suggestions cannot be added here.");
    await api.confirmFolderHint({
      sessionId,
      kind: proposal.kind,
      folder: proposal.folder
    });
    check();
  }
  const review = await reviewConversationOrganization(api, projects, sessionId);
  check();
  const reviewed = await reviewSourceCorrections(api, review, [
    proposal.kind === "repository"
      ? {
          axis: "git",
          action: "set",
          repository: anchor!.repository,
          expectedVersion: review.context.git.revision
        }
      : {
          axis: "folder",
          action: "set",
          folder: proposal.folder,
          expectedVersion: review.context.folder.revision
        }
  ]);
  check();
  const destination = reviewed.projects.find(
    (p) => p.id === destinationProjectId
  );
  if (!destination?.after)
    throw new Error(
      "The reviewed correction would not include this Conversation in the destination Project."
    );
  if (destination.before)
    throw new Error("This Conversation is already in the destination Project.");
  const result = await api.manageSourceContext({
    action: "organize",
    sessionId,
    edit: organizationEdit(review, [], reviewed.corrections)
  });
  check();
  if (
    !result.organization?.after.projects.some(
      ({ project, explanation }) =>
        project.projectId === destinationProjectId && explanation.included
    )
  )
    throw new Error(
      "The saved result did not confirm inclusion in the destination Project."
    );
}

/** Apply each suggestion in turn; ordinary failures do not stop the rest. */
export async function applySuggestions(
  api: PersonalDesktopApi,
  projects: readonly DesktopProject[],
  rows: readonly SuggestionRow[],
  destinationProjectId: string,
  check: () => void = () => {}
): Promise<{ done: number; failed: string[] }> {
  const failed: string[] = [];
  let done = 0;
  for (const row of rows) {
    check();
    try {
      await applySuggestion(api, projects, row, destinationProjectId, check);
      done += 1;
    } catch (cause) {
      check();
      failed.push(`${row.title}: ${projectErrorMessage(cause)}`);
    }
  }
  return { done, failed };
}
