import type { DesktopProject } from "../../../project-memory-ui.js";
import type { ProposalResolvers } from "./folder-hint-suggestion.js";
import { projectNamesForFolder } from "./folder-project.js";
import { projectNamesForRepository } from "./repository-project.js";

/** How a proposal learns which Projects a Folder or a Git Anchor is already in. */
export const proposalResolvers = (
  projects: readonly DesktopProject[]
): ProposalResolvers => ({
  folder: (folder) => projectNamesForFolder(projects, folder),
  repository: (key) => projectNamesForRepository(projects, key)
});
