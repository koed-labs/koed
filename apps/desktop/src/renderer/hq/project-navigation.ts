import type { Project } from "@koed/shared";
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";
import {
  sessionSelectionId,
  type DesktopProject
} from "../../project-memory-ui.js";

export type ProjectConversation = {
  technicalProjectId: string;
  thread: PersonalDesktopProjectThread;
};
export type ProjectNavigationRow = {
  id: string;
  name: string;
  conversations: ProjectConversation[];
};

/** Keep captured Session authority when pending drafts reuse the same execution identity. */
export function visibleHqProjects(
  personalProjects: readonly Project[],
  captured: readonly DesktopProject[],
  merged: readonly DesktopProject[]
): DesktopProject[] {
  const active = new Set(personalProjects.map(({ id }) => id));
  const capturedByRoute = new Map<string, PersonalDesktopProjectThread>();
  for (const project of captured)
    for (const thread of project.threads)
      capturedByRoute.set(
        `${project.id}\u0000${sessionSelectionId(thread)}`,
        thread
      );
  return merged.map((project) => ({
    ...project,
    threads: project.threads.flatMap((thread) => {
      const capturedThread = capturedByRoute.get(
        `${project.id}\u0000${sessionSelectionId(thread)}`
      );
      if (thread.conversationTrashedAt || capturedThread?.conversationTrashedAt)
        return [];
      const personalId = capturedThread
        ? capturedThread.personalProjectId
        : thread.personalProjectId;
      if (personalId && !active.has(personalId)) return [];
      return [{ ...thread, personalProjectId: personalId }];
    })
  }));
}

/** The Personal Project ID is a separate identity from a capture or runtime project ID. */
export function projectNavigation(
  personalProjects: readonly Project[],
  graphProjects: readonly DesktopProject[]
): { projects: ProjectNavigationRow[]; loose: ProjectConversation[] } {
  const active = new Set(personalProjects.map(({ id }) => id));
  const grouped = new Map<string, ProjectConversation[]>();
  const loose: ProjectConversation[] = [];
  for (const graphProject of graphProjects) {
    for (const thread of graphProject.threads) {
      if (thread.conversationTrashedAt) continue;
      const item = { technicalProjectId: graphProject.id, thread };
      const personalId = thread.personalProjectId;
      if (personalId === null) {
        loose.push(item);
        continue;
      }
      if (personalId === undefined) continue;
      if (!active.has(personalId)) continue;
      const rows = grouped.get(personalId) ?? [];
      rows.push(item);
      grouped.set(personalId, rows);
    }
  }
  return {
    projects: personalProjects.map(({ id, name }) => ({
      id,
      name,
      conversations: grouped.get(id) ?? []
    })),
    loose
  };
}
