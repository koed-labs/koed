import type { RepositoryIdentity } from "@koed/shared";
import {
  personalInventoryReference,
  type RecallActivityQuestion
} from "@koed/shared/personal-desktop";
import { repositoryScopeId } from "@koed/shared/repository-recall";
import {
  projectForLocalProject,
  repoLabelFromRemoteDisplay,
  type DesktopProject
} from "../../project-memory-ui.js";

const displayName = (value: string | null | undefined) => {
  const name = value?.trim();
  return name && !/^(repository|folder|project):\s*\{/.test(name) ? name : null;
};

/** Resolve labels only. Recorded identity and retrieval scope remain unchanged. */
export function recallProjectLabel(
  question: Pick<RecallActivityQuestion, "projectId" | "projectName">,
  projects: readonly DesktopProject[]
): string | null {
  const id = question.projectId;
  if (!id) return displayName(question.projectName);
  const project =
    projects.find(
      (candidate) =>
        candidate.id === id ||
        candidate.namedProject?.projectId === id ||
        personalInventoryReference(candidate).key === id
    ) ?? projectForLocalProject(projects, id);
  const name = displayName(project?.name);
  if (name) return name;

  // A Git Anchor may only appear inside a named Project's rules or members.
  // Use that anchor's own label, never infer named Project membership from it.
  const repositoryName = (
    repository: RepositoryIdentity | null | undefined
  ) => {
    if (
      !repository ||
      repository.kind === "unresolved" ||
      repositoryScopeId(repository) !== id
    )
      return null;
    return displayName(
      repository.anchorDisplay
        ? repoLabelFromRemoteDisplay(repository.anchorDisplay)
        : repository.root?.split(/[\\/]/).filter(Boolean).at(-1)
    );
  };
  for (const candidate of projects) {
    const repositories = [
      candidate.repository,
      ...(candidate.checkouts?.map((checkout) => checkout.repository) ?? []),
      ...(candidate.inclusionRules?.flatMap((rule) =>
        rule.target.kind === "repository" ? [rule.target.repository] : []
      ) ?? []),
      ...candidate.threads.map(
        (thread) => thread.repositoryAssignment?.effective
      )
    ];
    for (const repository of repositories) {
      const label = repositoryName(repository);
      if (label) return label;
    }
  }
  return displayName(question.projectName);
}
