import type { PersonalGitContext } from "@koed-labs/shared";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { projectTransferSources } from "../../views/personal/project-transfer-model.js";
import type { ProposalProject } from "./folder-hint-suggestion.js";

/** The Git Anchor a repository key names, if some Project already uses it. The
 * key is the portable fingerprint, the same for ssh and https remotes. */
export function repositoryTargetFor(
  projects: readonly DesktopProject[],
  key: string
): { sourceId: string; repository: PersonalGitContext } | undefined {
  for (const source of projectTransferSources(projects).repositories)
    if (
      source.target?.kind === "repository" &&
      source.target.repository.key === key
    )
      return { sourceId: source.id, repository: source.target.repository };
  return undefined;
}

/** Projects this Git Anchor is already in. Prefer named Projects over the
 * automatic group, which is not a destination in Project settings. */
export function projectsForRepository(
  projects: readonly DesktopProject[],
  key: string
): ProposalProject[] {
  if (!repositoryTargetFor(projects, key)) return [];
  const named: ProposalProject[] = [];
  const automatic: ProposalProject[] = [];
  for (const project of projects) {
    const { id, namedProject } = project;
    if (!namedProject) {
      if (project.repository?.key === key)
        automatic.push({ id, name: project.name });
      continue;
    }
    if (namedProject.deletedAt) continue;
    const covered = (project.inclusionRules ?? []).some(
      (rule) =>
        !rule.removedAt &&
        rule.target.kind === "repository" &&
        rule.target.repository.key === key
    );
    if (covered) named.push({ id, name: namedProject.name });
  }
  return named.length > 0 ? named : automatic;
}
