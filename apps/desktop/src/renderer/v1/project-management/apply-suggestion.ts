import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import {
  organizationEdit,
  reviewConversationOrganization,
  type OrganizationReview
} from "./conversation-organization.js";
import {
  previewSourceCorrection,
  reviewSourceCorrections
} from "./correction-review.js";
import { proposalRevision } from "./folder-hint-suggestion.js";
import { repositoryTargetFor } from "./repository-project.js";
import type { SuggestionRow } from "./use-folder-suggestions.js";
import { projectErrorMessage } from "./use-organization-review.js";

async function applyReviewedUnknown(
  api: PersonalDesktopApi,
  review: OrganizationReview,
  proposal: Extract<SuggestionRow["proposal"], { kind: "repository" }>,
  anchor: NonNullable<ReturnType<typeof repositoryTargetFor>>,
  destinationProjectId: string,
  check: () => void
) {
  if (
    proposal.gitRevision !== 1 ||
    !proposal.directory ||
    !proposal.manualGitReview
  )
    throw new Error("This Git Anchor suggestion is no longer available.");
  const preview = await previewSourceCorrection(
    api,
    review,
    {
      axis: "git",
      action: "set",
      repository: anchor.repository,
      expectedVersion: proposal.gitRevision,
      inferenceIntent: proposal.manualGitReview.intent
    },
    {
      directory: proposal.directory,
      incarnation: proposal.manualGitReview.incarnation
    }
  );
  check();
  const destination = preview.projects.find(
    (p) => p.projectId === destinationProjectId
  );
  const git = preview.after.git.correction;
  if (
    !destination?.afterIncluded ||
    destination.beforeIncluded ||
    !proposal.projects.some(({ id }) => id === destinationProjectId) ||
    git.state !== "corrected" ||
    git.value.state !== "known" ||
    git.value.value.kind !== "portable_repository" ||
    git.value.value.key !== proposal.repositoryKey
  )
    throw new Error(
      "The reviewed correction would not add this Conversation to the destination Project."
    );
  // Apply rechecks the saved review, including source and Project versions.
  const result = await api.manageSourceContext!({
    action: "apply",
    sessionId: review.context.sessionId,
    reviewId: preview.reviewId,
    expectedVersion: preview.expectedVersion,
    expectedScopeKey: review.expectedScopeKey
  });
  check();
  if (
    JSON.stringify(result.preview) !== JSON.stringify(preview) ||
    JSON.stringify(result.context) !== JSON.stringify(preview.after)
  )
    throw new Error(
      "The saved result did not confirm the reviewed Git Anchor."
    );
}

async function applySuggestion(
  api: PersonalDesktopApi,
  projects: readonly DesktopProject[],
  row: SuggestionRow,
  destinationProjectId: string,
  expectedScopeKey: string,
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
      folder: proposal.folder,
      expectedScopeKey
    });
    check();
  }
  const review = await reviewConversationOrganization(
    api,
    projects,
    sessionId,
    undefined,
    expectedScopeKey
  );
  check();
  const axis = proposal.kind === "repository" ? "git" : "folder";
  const expectedVersion = proposalRevision(proposal);
  if (
    expectedVersion !== review.context[axis].revision ||
    (axis === "folder" && review.context.folder.correction.state !== "original")
  )
    throw new Error(
      `${axis === "git" ? "Git Anchor" : "Folder"} changed. Review the suggestion again.`
    );
  if (proposal.kind === "repository" && proposal.manualGitReview)
    return applyReviewedUnknown(
      api,
      review,
      proposal,
      anchor!,
      destinationProjectId,
      check
    );
  const reviewed = await reviewSourceCorrections(api, review, [
    proposal.kind === "repository"
      ? {
          axis: "git",
          action: "set",
          repository: anchor!.repository,
          expectedVersion
        }
      : {
          axis: "folder",
          action: "set",
          folder: proposal.folder,
          expectedVersion
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
    expectedScopeKey,
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
  expectedScopeKey: string,
  check: () => void = () => {}
): Promise<{ done: number; failed: string[] }> {
  const failed: string[] = [];
  let done = 0;
  for (const row of rows) {
    check();
    try {
      await applySuggestion(
        api,
        projects,
        row,
        destinationProjectId,
        expectedScopeKey,
        check
      );
      done += 1;
    } catch (cause) {
      check();
      failed.push(`${row.title}: ${projectErrorMessage(cause)}`);
    }
  }
  return { done, failed };
}
