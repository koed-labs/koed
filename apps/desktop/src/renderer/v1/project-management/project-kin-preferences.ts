import type { DesktopProject } from "../../../project-memory-ui.js";
import { PROJECT_KIN_ACCESSORIES } from "../pixelkin/agent-kin.js";

const itemIds = new Set(PROJECT_KIN_ACCESSORIES.map(({ id }) => id));
const storageKey = (scopeKey: string, projectId: string) =>
  `koed:project-kin-items:${scopeKey}:${projectId}`;

function readItems(scopeKey: string, projectId: string): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(storageKey(scopeKey, projectId)) ?? "[]"
    );
    return Array.isArray(value)
      ? value.filter(
          (id): id is string => typeof id === "string" && itemIds.has(id)
        )
      : [];
  } catch {
    return [];
  }
}

export function withLocalProjectKinItems(
  projects: readonly DesktopProject[],
  scopeKey: string
): DesktopProject[] {
  return projects.map((project) => {
    if (!project.namedProject) return project;
    const kinItems = readItems(scopeKey, project.id);
    return kinItems.length || project.kinItems
      ? { ...project, kinItems: kinItems.length ? kinItems : undefined }
      : project;
  });
}

export function saveLocalProjectKinItems(
  scopeKey: string,
  projectId: string,
  items: string[]
): void {
  const key = storageKey(scopeKey, projectId);
  if (items.length) localStorage.setItem(key, JSON.stringify(items));
  else localStorage.removeItem(key);
}
