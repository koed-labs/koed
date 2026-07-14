export type DesktopThreadGroup = {
  id: string;
  name: string;
  sessionId?: string | null;
  sourceAiClient?: "codex" | "codex-cli" | null;
  projectId: string;
  projectName: string;
  projectPath?: string | null;
  projectAssignmentSource?: "detected" | "user_override" | null;
  capturedProjectProvenance?: Record<string, unknown>;
  eventCount: number;
  invalidatedCount: number;
  latestAt: string;
  sample: string;
};

export type DesktopProjectGroup = {
  id: string;
  name: string;
  path: string | null;
  eventCount: number;
  threads: DesktopThreadGroup[];
};

export type DesktopProjectMetadata = {
  schemaVersion: 1;
  discoveredAt: string;
  lastSeenAt: string;
  localProjectId: string;
  displayName: string;
  path: {
    cwd: string;
    projectRoot: string | null;
    basename: string;
    localPathHash: string;
  };
  git?: {
    branch: string | null;
    isWorktree: boolean;
    remotes: Array<{ display: string | null }>;
  };
};

export type DesktopProject = DesktopProjectGroup & {
  catalogued: boolean;
  discoveredAt: string | null;
  lastSeenAt: string | null;
  localProjectId: string | null;
  branch: string | null;
  remoteDisplay: string | null;
  isWorktree: boolean;
};

export type DesktopView = "projects" | "project" | "session" | "settings";

export const ACTIVE_PROJECT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const normalizedPath = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed || null;
};

const metadataPaths = (project: DesktopProjectMetadata): string[] =>
  [project.path.projectRoot, project.path.cwd]
    .map(normalizedPath)
    .filter((value): value is string => Boolean(value));

export const projectLatestAt = (
  project: Pick<DesktopProject, "threads" | "lastSeenAt">
): string | null => {
  const timestamps = [
    project.lastSeenAt,
    ...project.threads.map((thread) => thread.latestAt)
  ]
    .filter((value): value is string => Boolean(value))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();
  return timestamps.at(-1) ?? null;
};

export const projectIsActive = (
  project: DesktopProject,
  now = Date.now()
): boolean => {
  const latestAt = projectLatestAt(project);
  return latestAt
    ? now - Date.parse(latestAt) < ACTIVE_PROJECT_WINDOW_MS
    : false;
};

export const reconcileSelectedProjectId = (
  projects: DesktopProject[],
  selectedProjectId: string | null,
  preserveEmptySelection: boolean
): string | null => {
  if (
    !projects.length ||
    (selectedProjectId === null && preserveEmptySelection)
  ) {
    return null;
  }
  if (projects.some((project) => project.id === selectedProjectId)) {
    return selectedProjectId;
  }
  return projects.find((project) => projectIsActive(project))?.id ?? null;
};

export const sortProjects = (projects: DesktopProject[]): DesktopProject[] =>
  [...projects].sort((left, right) => {
    const activityDelta =
      Date.parse(projectLatestAt(right) ?? "0") -
      Date.parse(projectLatestAt(left) ?? "0");
    return activityDelta || left.name.localeCompare(right.name);
  });

const enrichProject = (
  project: DesktopProjectGroup,
  metadata: DesktopProjectMetadata | null
): DesktopProject => ({
  ...project,
  name: metadata?.displayName || project.name,
  path:
    project.path ?? metadata?.path.projectRoot ?? metadata?.path.cwd ?? null,
  catalogued: Boolean(metadata),
  discoveredAt: metadata?.discoveredAt ?? null,
  lastSeenAt: metadata?.lastSeenAt ?? null,
  localProjectId: metadata?.localProjectId ?? null,
  branch: metadata?.git?.branch ?? null,
  remoteDisplay:
    metadata?.git?.remotes.find((remote) => remote.display)?.display ?? null,
  isWorktree: metadata?.git?.isWorktree ?? false
});

export const mergeProjectSources = (
  graphProjects: DesktopProjectGroup[],
  metadataProjects: DesktopProjectMetadata[]
): DesktopProject[] => {
  const metadataByPath = new Map<string, DesktopProjectMetadata>();
  for (const project of metadataProjects) {
    for (const path of metadataPaths(project))
      metadataByPath.set(path, project);
  }

  const matchedMetadataIds = new Set<string>();
  const merged = graphProjects.map((project) => {
    const metadata = project.path
      ? (metadataByPath.get(normalizedPath(project.path) ?? "") ?? null)
      : null;
    if (metadata) matchedMetadataIds.add(metadata.localProjectId);
    return enrichProject(project, metadata);
  });

  for (const metadata of metadataProjects) {
    if (matchedMetadataIds.has(metadata.localProjectId)) continue;
    merged.push(
      enrichProject(
        {
          id: metadata.localProjectId,
          name: metadata.displayName,
          path: metadata.path.projectRoot ?? metadata.path.cwd,
          eventCount: 0,
          threads: []
        },
        metadata
      )
    );
  }

  return sortProjects(merged);
};

export const relativeTime = (
  value: string | null,
  now = Date.now()
): string => {
  if (!value || !Number.isFinite(Date.parse(value))) return "No activity";
  const minutes = Math.max(1, Math.round((now - Date.parse(value)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export { sessionSelectionId } from "@koed/memory-ui";

export const projectIdForSession = (
  projects: DesktopProjectGroup[],
  selectedSessionId: string
): string | null =>
  projects.find((project) =>
    project.threads.some(
      (thread) => sessionSelectionId(thread) === selectedSessionId
    )
  )?.id ?? null;

export const assignmentTargetProjects = (
  projects: DesktopProject[],
  currentProjectId?: string
): DesktopProject[] =>
  sortProjects(
    projects.filter(
      (project) =>
        project.id !== "unassigned" &&
        project.id !== currentProjectId &&
        Boolean(project.id.trim()) &&
        Boolean(project.name.trim())
    )
  );

export class LatestRequestGate {
  private revision = 0;

  begin(): number {
    this.revision += 1;
    return this.revision;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}
import { sessionSelectionId } from "@koed/memory-ui";
