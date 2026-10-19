import type { RepositoryIdentity } from "@koed/shared";
import { repositoryScopeId } from "@koed/shared/repository-recall";
import { projectConversationFolders } from "./project-conversation-folders.js";
import {
  repoLabelFromRemoteDisplay,
  sessionSelectionId,
  type DesktopProject
} from "./project-memory-ui.js";

const isGit = (identity: RepositoryIdentity | undefined | null) =>
  identity?.kind === "portable_repository" ||
  identity?.kind === "device_local_repository";

const folderKey = (path: string, device: string) => {
  let normalized = path.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  if (/^[a-z]:\//i.test(normalized)) normalized = normalized.toLowerCase();
  return JSON.stringify([device, normalized]);
};

export type ProjectRowPresentation = {
  kind: "project" | "git" | "folder" | "independent" | "unresolved";
  sourceLabel: string;
  context: string | null;
  contextKind: "repository" | "folder" | "mixed" | null;
  conversationCount: number;
};

function manualProjectContext(project: DesktopProject) {
  const { folders, byThread } = projectConversationFolders(project);
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const repositories = new Map<string, RepositoryIdentity>();
  const gitFolders = new Set<string>();
  const addRepository = (identity: RepositoryIdentity | undefined | null) => {
    if (identity && isGit(identity)) {
      const key = repositoryScopeId(identity);
      const current = repositories.get(key);
      if (!current || (!current.anchorDisplay && identity.anchorDisplay))
        repositories.set(key, identity);
    }
  };
  for (const folder of folders) {
    addRepository(folder.repository);
    if (isGit(folder.repository)) gitFolders.add(folder.id);
  }
  for (const thread of project.threads) {
    const automatic = thread.repositoryAssignment?.automatic;
    addRepository(automatic);
    const folderId = byThread.get(sessionSelectionId(thread));
    const folder = folderId ? foldersById.get(folderId) : undefined;
    if (folder?.path && automatic && isGit(automatic))
      gitFolders.add(folderKey(folder.path, automatic.originatingDeviceId));
  }
  const plainFolders = new Map(
    folders
      .filter((folder) => folder.path && !gitFolders.has(folder.id))
      .map((folder) => [folder.id, folder.path!])
  );
  // Historical plain folders may share a path across devices. Preserve the
  // recorded device in the summary even when a display folder matched by path.
  for (const thread of project.threads) {
    const automatic = thread.repositoryAssignment?.automatic;
    const source =
      automatic?.root ??
      thread.capturedCwd ??
      (thread.projectAssignmentSource !== "user_override"
        ? thread.projectPath
        : null);
    if (!source || isGit(automatic)) continue;
    const folderId = byThread.get(sessionSelectionId(thread));
    const folder = folderId ? foldersById.get(folderId) : undefined;
    if (!folder?.path) continue;
    const device =
      automatic?.originatingDeviceId ??
      thread.originDevice?.id ??
      folder.repository?.originatingDeviceId ??
      "";
    const key = folderKey(folder.path, device);
    if (!gitFolders.has(key)) plainFolders.set(key, folder.path);
  }
  const repository = [...repositories.values()][0];
  const repositoryLabel =
    repositories.size === 1 && repository?.anchorDisplay
      ? repoLabelFromRemoteDisplay(repository.anchorDisplay)
      : repositories.size
        ? `${repositories.size} ${repositories.size === 1 ? "repository" : "repositories"}`
        : null;
  const folderLabel =
    plainFolders.size === 1 && !repositoryLabel
      ? [...plainFolders.values()][0]!
      : plainFolders.size
        ? `${plainFolders.size} ${plainFolders.size === 1 ? "folder" : "folders"}`
        : null;
  return {
    context: [repositoryLabel, folderLabel].filter(Boolean).join(" · ") || null,
    contextKind:
      repositoryLabel && folderLabel
        ? ("mixed" as const)
        : repositoryLabel
          ? ("repository" as const)
          : folderLabel
            ? ("folder" as const)
            : null
  };
}

export function projectRowPresentation(
  project: DesktopProject
): ProjectRowPresentation {
  const conversationCount = project.threads.filter(
    (thread) => thread.threadKind !== "subagent"
  ).length;
  if (project.contextKind === "independent") {
    return {
      kind: "independent",
      sourceLabel: "Independent Conversations",
      context: null,
      contextKind: null,
      conversationCount
    };
  }
  if (project.repository?.kind === "local_project") {
    return {
      kind: "project",
      sourceLabel: "Manual Project",
      ...manualProjectContext(project),
      conversationCount
    };
  }
  if (isGit(project.repository)) {
    const remote = project.repository?.anchorDisplay ?? project.remoteDisplay;
    return {
      kind: "git",
      sourceLabel: "Git grouping",
      context: remote ? repoLabelFromRemoteDisplay(remote) : project.path,
      contextKind: remote ? "repository" : project.path ? "folder" : null,
      conversationCount
    };
  }
  const unresolved =
    project.id === "unassigned" || project.repository?.kind === "unresolved";
  const path = project.path ?? project.repository?.root ?? null;
  const folder =
    !unresolved && (project.repository?.kind === "non_git_project" || !!path);
  return {
    kind: folder ? "folder" : "unresolved",
    sourceLabel: folder ? "Folder grouping" : "Unresolved grouping",
    context: unresolved ? null : path,
    contextKind: !unresolved && path ? "folder" : null,
    conversationCount
  };
}
