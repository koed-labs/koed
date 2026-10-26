import type {
  OwnedRepositorySharingRule,
  RepositoryIdentity
} from "@koed/shared";
import { sharingSelectionDescriptor } from "@koed/shared/collaboration";
import {
  repoLabelFromRemoteDisplay,
  type DesktopProject
} from "../../project-memory-ui.js";

type Selector = OwnedRepositorySharingRule["selector"];
type Target = Parameters<typeof sharingSelectionDescriptor>[0];

const selectorKey = (selector: Selector) =>
  JSON.stringify([
    selector.kind,
    selector.key,
    selector.kind === "device_local_repository"
      ? selector.originatingDeviceId
      : null
  ]);

// Local display names are presentation only; mutations keep the original selector.
export function localSharingRuleLabels(projects: readonly DesktopProject[]) {
  const labels = new Map<string, string>();
  const addRepository = (
    repository: RepositoryIdentity | undefined,
    fallback?: string
  ) => {
    if (
      !repository ||
      (repository.kind !== "portable_repository" &&
        repository.kind !== "device_local_repository")
    )
      return;
    const label = repository.anchorDisplay
      ? repoLabelFromRemoteDisplay(repository.anchorDisplay)
      : (repository.root?.split(/[\\/]/).filter(Boolean).at(-1) ?? fallback);
    if (label && !labels.has(selectorKey(repository)))
      labels.set(selectorKey(repository), label);
  };
  for (const project of projects) {
    addRepository(project.repository, project.name);
    for (const checkout of project.checkouts ?? [])
      addRepository(
        checkout.repository,
        checkout.path.split(/[\\/]/).filter(Boolean).at(-1)
      );
    for (const rule of project.inclusionRules ?? []) {
      if (rule.target.kind === "repository")
        addRepository(rule.target.repository);
    }
    for (const thread of project.threads)
      addRepository(thread.repositoryAssignment?.effective ?? undefined);
    if (project.projectReference)
      labels.set(
        selectorKey(
          sharingSelectionDescriptor({
            kind: "project",
            project: project.projectReference
          })
        ),
        project.name
      );
  }
  return labels;
}

export function sharingRuleLabel(
  selector: Selector,
  labels: ReadonlyMap<string, string>,
  target?: Target
) {
  if (
    target?.kind === "repository" &&
    selectorKey(sharingSelectionDescriptor(target)) === selectorKey(selector) &&
    target.repository.anchorDisplay
  )
    return repoLabelFromRemoteDisplay(target.repository.anchorDisplay);
  return (
    labels.get(selectorKey(selector)) ??
    (selector.kind === "folder"
      ? "Folder sharing rule"
      : selector.kind === "project"
        ? "Project sharing rule"
        : "Git Anchor unavailable on this device")
  );
}
