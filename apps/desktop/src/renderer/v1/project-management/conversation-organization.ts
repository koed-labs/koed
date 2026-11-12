import type {
  PersonalConversationOrganizationInput,
  PersonalConversationOrganizationResult,
  PersonalProjectMembershipExplanation,
  PersonalSourceContextState,
  PersonalSourceCorrectionInput
} from "@koed-labs/shared";
import type { PersonalDesktopApi } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";

export type MembershipReview = {
  project: DesktopProject;
  explanation: PersonalProjectMembershipExplanation;
};
export type OrganizationReview = {
  context: PersonalSourceContextState;
  projects: readonly DesktopProject[];
  memberships: MembershipReview[];
};
export const activeNamedProjects = (projects: readonly DesktopProject[]) =>
  projects.filter(
    (project) => project.namedProject && !project.namedProject.deletedAt
  );
export const excludedMembership = (
  explanation: PersonalProjectMembershipExplanation
) =>
  explanation.exclusion?.clearedAt === null ||
  !!explanation.syncExclusion?.blocked;
export const unresolvedMembership = (
  explanation: PersonalProjectMembershipExplanation
) =>
  !!explanation.syncExclusion &&
  (explanation.syncExclusion.state !== "available" ||
    (explanation.syncExclusion.blocked && !explanation.exclusion));
export const directMembership = (
  explanation: PersonalProjectMembershipExplanation
) => explanation.reasons.some((reason) => reason.kind === "session");

export async function reviewConversationOrganization(
  api: PersonalDesktopApi,
  projects: readonly DesktopProject[],
  sessionId: string,
  projectIds?: readonly string[]
): Promise<OrganizationReview> {
  if (!api.manageSourceContext || !api.manageProject)
    throw new Error("Project management is unavailable.");
  const named = activeNamedProjects(projects);
  const [source, memberships] = await Promise.all([
    api.manageSourceContext({ action: "get", sessionId }),
    Promise.all(
      named
        .filter((p) => !projectIds || projectIds.includes(p.id))
        .map(async (project) => {
          const result = await api.manageProject!({
            action: "explain_session",
            projectId: project.id,
            expectedVersion: project.namedProject!.version,
            sessionId
          });
          if (
            result.project.projectId !== project.id ||
            result.project.version !== project.namedProject!.version ||
            result.explanation?.sessionId !== sessionId
          )
            throw new Error(
              "Project membership changed. Reopen this dialog to review it again."
            );
          return { project, explanation: result.explanation };
        })
    )
  ]);
  if (
    source.context.sessionId !== sessionId ||
    memberships.some(
      (m) => m.explanation.logicalSessionId !== source.context.logicalSessionId
    )
  )
    throw new Error("Conversation identity could not be verified.");
  return { context: source.context, projects: named, memberships };
}

export function organizationEdit(
  review: OrganizationReview,
  memberships: PersonalConversationOrganizationInput["memberships"],
  corrections: PersonalSourceCorrectionInput[] = []
): PersonalConversationOrganizationInput {
  return {
    expectedContext: review.context,
    reviewedProjects: review.projects
      .filter(
        (p) =>
          corrections.length || memberships.some((m) => m.projectId === p.id)
      )
      .map((p) => ({
        projectId: p.id,
        expectedVersion: p.namedProject!.version
      })),
    memberships,
    corrections
  };
}

export function moveConversationEdit(
  review: OrganizationReview,
  from: string | undefined,
  to: string,
  options: {
    restore?: boolean;
    removeGit?: boolean;
    removeFolder?: boolean;
  } = {}
): PersonalConversationOrganizationInput | null {
  if (from === to) return null;
  const source = review.memberships.find((m) => m.project.id === from);
  const target = review.memberships.find((m) => m.project.id === to);
  if (!target || !target.project.namedProject)
    throw new Error("The destination Project is no longer available.");
  if (unresolvedMembership(target.explanation))
    throw new Error("Review the destination Project's sync conflict first.");
  const exclusion = target.explanation.exclusion;
  if (
    excludedMembership(target.explanation) &&
    (!options.restore || !exclusion)
  )
    throw new Error(
      "Restore this Conversation before moving it into the Project."
    );
  if (source && !source.explanation.included)
    throw new Error("The Conversation is no longer in the source Project.");
  const memberships: PersonalConversationOrganizationInput["memberships"] = [
    ...(source
      ? [
          {
            projectId: source.project.id,
            direct: false,
            excluded: source.explanation.reasons.some(
              (reason) => reason.kind !== "session"
            )
          }
        ]
      : []),
    {
      projectId: target.project.id,
      direct: true,
      excluded: false,
      ...(excludedMembership(target.explanation) && exclusion
        ? {
            restoreExclusion: {
              exclusionId: exclusion.exclusionId,
              expectedExclusionRevisionId: exclusion.headRevisionId
            }
          }
        : {})
    }
  ];
  const corrections: PersonalSourceCorrectionInput[] = [];
  if (options.removeGit)
    corrections.push({
      axis: "git",
      action: "unresolved",
      expectedVersion: review.context.git.revision
    });
  if (options.removeFolder)
    corrections.push({
      axis: "folder",
      action: "unresolved",
      expectedVersion: review.context.folder.revision
    });
  return organizationEdit(review, memberships, corrections);
}

/** Undo is another version-pinned durable edit. It never rewinds capture,
 * restores whole stale inventories, or silently overwrites a newer correction. */
export function inverseOrganizationEdit(
  result: PersonalConversationOrganizationResult
): PersonalConversationOrganizationInput | null {
  const memberships: PersonalConversationOrganizationInput["memberships"] = [];
  for (const before of result.before.projects) {
    const after = result.after.projects.find(
      (p) => p.project.projectId === before.project.projectId
    );
    if (!after) throw new Error("The organization result is incomplete.");
    const direct = directMembership(before.explanation),
      excluded = excludedMembership(before.explanation);
    if (
      direct === directMembership(after.explanation) &&
      excluded === excludedMembership(after.explanation)
    )
      continue;
    const exclusion = after.explanation.exclusion;
    memberships.push({
      projectId: before.project.projectId,
      direct,
      excluded,
      ...(exclusion?.clearedAt === null &&
      (!excluded || direct !== directMembership(after.explanation))
        ? {
            restoreExclusion: {
              exclusionId: exclusion.exclusionId,
              expectedExclusionRevisionId: exclusion.headRevisionId
            }
          }
        : {})
    });
  }
  const corrections: PersonalSourceCorrectionInput[] = [];
  for (const axis of ["git", "folder"] as const) {
    const before = result.before.context[axis],
      after = result.after.context[axis];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (before.correction.state === "original") {
      corrections.push({
        axis,
        action: "reset",
        expectedVersion: after.revision
      });
    } else if (before.correction.value.state === "unresolved") {
      corrections.push({
        axis,
        action: "unresolved",
        expectedVersion: after.revision
      });
    } else if (axis === "git") {
      const original = result.before.context.git.correction;
      if (original.state === "corrected" && original.value.state === "known")
        corrections.push({
          axis,
          action: "set",
          repository: original.value.value,
          expectedVersion: after.revision
        });
    } else {
      const original = result.before.context.folder.correction;
      if (original.state === "corrected" && original.value.state === "known")
        corrections.push({
          axis,
          action: "set",
          folder: original.value.value.reference,
          expectedVersion: after.revision
        });
    }
  }
  return memberships.length || corrections.length
    ? {
        expectedContext: result.after.context,
        reviewedProjects: result.after.projects.map((p) => ({
          projectId: p.project.projectId,
          expectedVersion: p.project.version
        })),
        memberships,
        corrections
      }
    : null;
}
