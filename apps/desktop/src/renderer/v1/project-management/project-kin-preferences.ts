import type { DesktopProject } from "../../../project-memory-ui.js";
import { PixelkinAccessories } from "@koed-labs/kin-engine";

const itemIds = new Set(PixelkinAccessories.map(({ id }) => id));
const storageKey = (scopeKey: string, projectId: string) =>
  `koed:project-kin-items:${scopeKey}:${projectId}`;

export function localProjectKinItems(
  scopeKey: string,
  projectId: string
): string[] | undefined {
  try {
    const raw = localStorage.getItem(storageKey(scopeKey, projectId));
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter(
          (id): id is string => typeof id === "string" && itemIds.has(id)
        )
      : undefined;
  } catch {
    return undefined;
  }
}

export function withLocalProjectKinItems(
  projects: readonly DesktopProject[],
  scopeKey: string
): DesktopProject[] {
  return projects.map((project) => {
    if (!project.namedProject) return project;
    const kinItems = localProjectKinItems(scopeKey, project.id);
    if (!kinItems && !project.kinItems) return project;
    return { ...project, kinItems };
  });
}

export function saveLocalProjectKinItems(
  scopeKey: string,
  projectId: string,
  items: string[],
  legacyHat?: string
): void {
  const key = storageKey(scopeKey, projectId);
  if (items.length || legacyHat)
    localStorage.setItem(key, JSON.stringify(items));
  else localStorage.removeItem(key);
}
