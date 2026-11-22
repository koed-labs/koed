import type { PersonalGitContext } from "@koed-labs/shared";
import type { DesktopProject } from "../../../project-memory-ui.js";
import { projectTransferSources } from "../../views/personal/project-transfer-model.js";

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

/** Names of the Projects this Git Anchor is already in. Empty when the anchor
 * is unknown to every Project, so there is nothing a correction could select. */
export function projectNamesForRepository(
  projects: readonly DesktopProject[],
  key: string
): string[] {
  const target = repositoryTargetFor(projects, key);
  if (!target) return [];
  const names = new Set<string>();
  for (const project of projects) {
    if (project.repository?.key === key) names.add(project.name);
    if (!project.namedProject) continue;
    const covered = (project.inclusionRules ?? []).some(
      (rule) =>
        !rule.removedAt &&
        rule.target.kind === "repository" &&
        rule.target.repository.key === key
    );
    if (covered) names.add(project.namedProject.name);
  }
  // A Project built on the anchor is named after its address
  // ("github.com/org/repo"); when a Project with a real name also uses it, drop
  // the address so the User reads one destination, not two.
  const address = target.repository.anchorDisplay;
  const named = [...names].filter((name) => name !== address);
  return named.length > 0 ? named : [...names];
}
