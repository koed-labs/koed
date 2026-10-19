import {
  sessionSelectionId,
  type DesktopProject
} from "../../project-memory-ui.js";

/** HQ owns its destinations; these cannot fall through to legacy Desktop views. */
export type HqRoute =
  | { kind: "home" }
  | { kind: "project"; projectId: string }
  | { kind: "conversation"; projectId: string; sessionId: string };

/** Retain a missing selection unless its identity has exactly one successor. */
export function reconcileHqRoute(
  route: HqRoute,
  retainedProject: DesktopProject | undefined,
  projects: readonly DesktopProject[]
): HqRoute {
  if (route.kind === "home") return route;
  const current = projects.find(({ id }) => id === route.projectId);
  if (route.kind === "conversation") {
    if (
      current?.threads.some(
        (thread) => sessionSelectionId(thread) === route.sessionId
      )
    )
      return route;
    const matches = projects.filter((project) =>
      project.threads.some(
        (thread) => sessionSelectionId(thread) === route.sessionId
      )
    );
    return matches.length === 1
      ? { ...route, projectId: matches[0]!.id }
      : route;
  }
  if (current || !retainedProject) return route;
  const sessions = retainedProject.threads.map(sessionSelectionId);
  const matches = projects.filter((project) => {
    if (
      retainedProject.localProjectId &&
      project.localProjectId === retainedProject.localProjectId
    )
      return true;
    return (
      sessions.length > 0 &&
      sessions.every((id) =>
        project.threads.some((thread) => sessionSelectionId(thread) === id)
      )
    );
  });
  return matches.length === 1 ? { ...route, projectId: matches[0]!.id } : route;
}
