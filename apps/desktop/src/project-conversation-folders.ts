import type { RepositoryIdentity } from "@koed/shared";
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import {
  sessionSelectionId,
  type DesktopProject
} from "./project-memory-ui.js";

export type ProjectConversationFolder = {
  id: string;
  path: string | null;
  localProjectId: string | null;
  originatingDeviceId: string;
  historical: boolean;
  repository?: RepositoryIdentity;
  repositoryRemotes?: DesktopProject["repositoryRemotes"];
  count: number;
};
export const otherConversationFolderId = "other-conversations";
const normalizedPath = (path: string) => {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
};
const within = (path: string, folder: string) =>
  path === folder || path.startsWith(folder === "/" ? folder : `${folder}/`);
const folderId = (path: string, device: string) =>
  JSON.stringify([device, normalizedPath(path)]);

// This groups display rows only. It never establishes repository identity.
export function projectConversationFolders(project: DesktopProject) {
  const folders: ProjectConversationFolder[] = (
    project.checkouts?.length
      ? project.checkouts
      : project.path
        ? [
            {
              localProjectId: project.localProjectId,
              path: project.path,
              repository: project.repository,
              repositoryRemotes: project.repositoryRemotes
            }
          ]
        : []
  )
    .map((folder) => ({
      ...folder,
      id: folderId(folder.path, folder.repository?.originatingDeviceId ?? ""),
      originatingDeviceId: folder.repository?.originatingDeviceId ?? "",
      historical:
        folder.repository?.originatingDeviceId === "historical_unknown_device",
      count: 0
    }))
    .filter(
      (folder, index, entries) =>
        entries.findIndex((entry) => entry.id === folder.id) === index
    );
  const byThread = new Map<string, string>();
  const threads = new Map(project.threads.map((thread) => [thread.id, thread]));
  const resolve = (
    thread: PersonalDesktopProjectThread,
    ancestors = new Set<string>()
  ): string => {
    const key = sessionSelectionId(thread);
    const known = byThread.get(key);
    if (known) return known;
    const automatic = thread.repositoryAssignment?.automatic;
    const device = automatic?.originatingDeviceId ?? thread.originDevice?.id;
    const source =
      automatic?.root ??
      thread.capturedCwd ??
      (thread.projectAssignmentSource !== "user_override"
        ? thread.projectPath
        : null);
    let folder = automatic?.checkoutId
      ? folders.find(
          (candidate) =>
            candidate.repository?.checkoutId === automatic.checkoutId &&
            candidate.repository.originatingDeviceId ===
              automatic.originatingDeviceId
        )
      : undefined;
    if (!folder && source) {
      const path = normalizedPath(source);
      folder = folders
        .filter(
          (candidate) =>
            candidate.path &&
            (!device ||
              !candidate.originatingDeviceId ||
              candidate.originatingDeviceId === device) &&
            (automatic?.root
              ? path === normalizedPath(candidate.path)
              : within(path, normalizedPath(candidate.path)))
        )
        .sort((a, b) => b.path!.length - a.path!.length)[0];
      if (!folder) {
        folder = {
          id: folderId(source, device ?? ""),
          path: source,
          localProjectId: null,
          originatingDeviceId: device ?? "",
          historical: device === "historical_unknown_device",
          count: 0
        };
        folders.push(folder);
      }
    }
    if (
      !folder &&
      thread.threadKind === "subagent" &&
      thread.parentThreadId &&
      !ancestors.has(thread.id)
    ) {
      const parent = threads.get(thread.parentThreadId);
      if (parent) {
        const inherited = resolve(parent, new Set(ancestors).add(thread.id));
        byThread.set(key, inherited);
        return inherited;
      }
    }
    const id = folder?.id ?? otherConversationFolderId;
    byThread.set(key, id);
    return id;
  };
  for (const thread of project.threads) {
    const id = resolve(thread);
    let folder = folders.find((entry) => entry.id === id);
    if (!folder) {
      folder = {
        id,
        path: null,
        localProjectId: null,
        originatingDeviceId: "",
        historical: false,
        count: 0
      };
      folders.push(folder);
    }
    folder.count += 1;
  }
  return { folders, byThread };
}
