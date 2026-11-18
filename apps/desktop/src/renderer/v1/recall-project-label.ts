import type { RepositoryIdentity } from "@koed-labs/shared";
import {
  personalInventoryReference,
  type RecallActivityQuestion
} from "@koed-labs/shared/personal-desktop";
import { repositoryScopeId } from "@koed-labs/shared/repository-recall";
import {
  projectForLocalProject,
  repoLabelFromRemoteDisplay,
  type DesktopProject
} from "../../project-memory-ui.js";

const displayName = (value: string | null | undefined) => {
  const name = value?.trim();
  return name && !/^(repository|folder|project):\s*\{/.test(name) ? name : null;
};

/** Resolve labels only. Recorded identity and retrieval scope remain unchanged.
 * A `projectName` of null is the activity API's verdict that a named Project is
 * unavailable; pass undefined when no API label is known so the sidebar is used. */
export function recallProjectLabel(
  question: Pick<RecallActivityQuestion, "projectId"> & {
    projectName?: RecallActivityQuestion["projectName"];
  },
  projects: readonly DesktopProject[]
): string | null {
  const id = question.projectId;
  if (!id) return displayName(question.projectName);
  // Named Project labels are resolved by the owner-authorized activity API.
  // A stale sidebar must not resurrect a deleted Project's name.
  if (
    question.projectName !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return displayName(question.projectName);
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
