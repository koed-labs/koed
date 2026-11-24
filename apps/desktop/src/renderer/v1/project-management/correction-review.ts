import type {
  PersonalSourceCorrectionInput,
  PersonalSourceCorrectionPreview
} from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import {
  excludedMembership,
  type OrganizationReview
} from "./conversation-organization.js";

export type CorrectionReview = {
  corrections: PersonalSourceCorrectionInput[];
  projects: { id: string; name: string; before: boolean; after: boolean }[];
};

export async function previewSourceCorrection(
  api: PersonalDesktopApi,
  review: OrganizationReview,
  correction: PersonalSourceCorrectionInput,
  reviewedDirectory?: string
): Promise<PersonalSourceCorrectionPreview> {
  const { preview } = await api.manageSourceContext!({
    action: "preview",
    sessionId: review.context.sessionId,
    correction,
    ...(review.expectedScopeKey
      ? { expectedScopeKey: review.expectedScopeKey }
      : {}),
    ...(reviewedDirectory ? { reviewedDirectory } : {})
  });
  if (
    !preview ||
    preview.axis !== correction.axis ||
    preview.expectedVersion !== correction.expectedVersion ||
    preview.inferenceIntent !==
      ("inferenceIntent" in correction
        ? correction.inferenceIntent
        : undefined) ||
    JSON.stringify(preview.before) !== JSON.stringify(review.context) ||
    preview.projects.length !== review.projects.length ||
    review.projects.some(
      (p) =>
        !preview.projects.some(
          (row) =>
            row.projectId === p.id && row.version === p.namedProject!.version
        )
    )
  )
    throw new Error(
      "Source context or Projects changed. Reopen to review the latest state."
    );
  return preview;
}

/** Combine the server's independently reviewed axes. Direct membership and
 * exclusions remain authoritative; neither axis can override the other. */
export async function reviewSourceCorrections(
  api: PersonalDesktopApi,
  review: OrganizationReview,
  corrections: PersonalSourceCorrectionInput[]
): Promise<CorrectionReview> {
  const previews = await Promise.all(
    corrections.map((correction) =>
      previewSourceCorrection(api, review, correction)
    )
  );
  return combineCorrectionPreviews(review, corrections, previews);
}

export function combineCorrectionPreviews(
  review: OrganizationReview,
  corrections: PersonalSourceCorrectionInput[],
  previews: PersonalSourceCorrectionPreview[]
): CorrectionReview {
  return {
    corrections,
    projects: review.memberships.map(({ project, explanation }) => {
      const single =
        previews.length === 1
          ? previews[0]!.projects.find((p) => p.projectId === project.id)
          : undefined;
      if (single)
        return {
          id: project.id,
          name: project.name,
          before: single.beforeIncluded,
          after: single.afterIncluded
        };
      const reasons = ["session", "repository", "folder"].flatMap((kind) => {
        const preview = previews.find(
          (p) => p.axis === (kind === "repository" ? "git" : kind)
        );
        const source =
          preview?.projects.find((p) => p.projectId === project.id)
            ?.afterReasons ?? explanation.reasons;
        return source.filter((reason) => reason.kind === kind);
      });
      return {
        id: project.id,
        name: project.name,
        before: explanation.included,
        after: reasons.length > 0 && !excludedMembership(explanation)
      };
    })
  };
}
