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

/** Combine the server's independently reviewed axes. Direct membership and
 * exclusions remain authoritative; neither axis can override the other. */
export async function reviewSourceCorrections(
  api: PersonalDesktopApi,
  review: OrganizationReview,
  corrections: PersonalSourceCorrectionInput[]
): Promise<CorrectionReview> {
  const previews = await Promise.all(
    corrections.map(async (correction) => {
      const result = await api.manageSourceContext!({
        action: "preview",
        sessionId: review.context.sessionId,
        correction
      });
      const preview = result.preview;
      if (
        !preview ||
        JSON.stringify(preview.before) !== JSON.stringify(review.context) ||
        preview.projects.length !== review.projects.length ||
        review.projects.some(
          (p) =>
            !preview.projects.some(
              (row) =>
                row.projectId === p.id &&
                row.version === p.namedProject!.version
            )
        )
      )
        throw new Error(
          "Source context or Projects changed. Reopen to review the latest state."
        );
      return preview;
    })
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
