import type { PersonalFolderReference } from "@koed-labs/shared";
import { personalFolderScopeId } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";

/** Names of the Projects this exact Folder is already in: a Project built on
 * the Folder itself (how Folders appear in the sidebar), or a named Project
 * with an active rule for it. A Folder no Project covers returns nothing, so a
 * suggestion for it is a Folder suggestion rather than a Project one. */
export function projectNamesForFolder(
  projects: readonly DesktopProject[],
  folder: PersonalFolderReference
): string[] {
  const id = personalFolderScopeId(folder);
  const names = new Set<string>();
  for (const project of projects) {
    if (
      project.folder &&
      personalFolderScopeId(project.folder.reference) === id
    )
      names.add(project.name);
    if (!project.namedProject) continue;
    const covered = (project.inclusionRules ?? []).some(
      (rule) =>
        !rule.removedAt &&
        rule.target.kind === "folder" &&
        personalFolderScopeId(rule.target.folder) === id
    );
    if (covered) names.add(project.namedProject.name);
  }
  return [...names];
}
