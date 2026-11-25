import type { PersonalFolderReference } from "@koed-labs/shared";
import { personalFolderScopeId } from "@koed-labs/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";

import type { ProposalProject } from "./folder-hint-suggestion.js";

/** Projects this exact Folder is already in: a Project built on
 * the Folder itself (how Folders appear in the sidebar), or a named Project
 * with an active rule for it. A Folder no Project covers returns nothing, so a
 * suggestion for it is a Folder suggestion rather than a Project one. */
export function projectsForFolder(
  projects: readonly DesktopProject[],
  folder: PersonalFolderReference
): ProposalProject[] {
  const folderId = personalFolderScopeId(folder);
  const matches = new Map<string, ProposalProject>();
  for (const project of projects) {
    const { id, namedProject } = project;
    if (namedProject?.deletedAt) continue;
    const covered = namedProject
      ? (project.inclusionRules ?? []).some(
          (rule) =>
            !rule.removedAt &&
            rule.target.kind === "folder" &&
            personalFolderScopeId(rule.target.folder) === folderId
        )
      : project.folder &&
        personalFolderScopeId(project.folder.reference) === folderId;
    if (covered)
      matches.set(id, { id, name: namedProject?.name ?? project.name });
  }
  return [...matches.values()];
}
