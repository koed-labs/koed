import { repositoryScopeId } from "@koed/shared/repository-recall";
import type { RepositoryAssignment, RepositoryIdentity } from "@koed/shared";
import type { PersonalDesktopProjectThread } from "@koed/shared/personal-desktop";

export type DesktopThreadGroup = {
  id: string;
  name: string;
  sessionId?: string | null;
  sourceAiClient?: "codex" | "codex-cli" | "claude-code" | "pi" | null;
  projectId: string;
  projectName: string;
  projectPath?: string | null;
  projectAssignmentSource?: "detected" | "user_override" | null;
  capturedProjectProvenance?: Record<string, unknown>;
  repositoryAssignment?: RepositoryAssignment;
  eventCount: number;
  invalidatedCount: number;
  latestAt: string;
  sample: string;
  threadKind?: "conversation" | "subagent";
  parentThreadId?: string | null;
  parentSessionId?: string | null;
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
  repository?: RepositoryIdentity;
  contextKind?: "project" | "independent";
  path: {
    cwd: string;
    projectRoot: string | null;
    basename?: string;
    localPathHash?: string;
  };
  git?: {
    branch: string | null;
    isWorktree: boolean;
    remotes: Array<{ name?: string; display: string | null }>;
  };
};

export type DesktopProject = Omit<DesktopProjectGroup, "threads"> & {
  threads: PersonalDesktopProjectThread[];
  contextKind?: "project" | "independent";
  catalogued: boolean;
  discoveredAt: string | null;
  lastSeenAt: string | null;
  localProjectId: string | null;
  branch: string | null;
  remoteDisplay: string | null;
  repository?: RepositoryIdentity;
  repositoryRemotes?: Array<{ name?: string; display: string | null }>;
  isWorktree: boolean;
  checkouts?: Array<{
    localProjectId: string;
    path: string;
    repository?: RepositoryIdentity;
  }>;
};

export type DesktopView =
  | "projects"
  | "project"
  | "session"
  | "chat"
  | "settings";

export const ACTIVE_PROJECT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type RepositoryPresentation = {
  host: string;
  label: string;
  provider: "github" | "git";
  url: string;
};

export const repositoryPresentationFromRemoteDisplay = (
  remoteDisplay: string
): RepositoryPresentation => {
  const normalized = remoteDisplay.trim();
  const separator = normalized.indexOf("/");
  const host = (
    separator === -1 ? normalized : normalized.slice(0, separator)
  ).toLocaleLowerCase();
  const github = host === "github.com";
  return {
    host,
    label: github ? normalized.slice(separator + 1) : normalized,
    provider: github ? "github" : "git",
    url: `https://${normalized}`
  };
};

export const repoUrlFromRemoteDisplay = (remoteDisplay: string): string =>
  repositoryPresentationFromRemoteDisplay(remoteDisplay).url;

export const repoLabelFromRemoteDisplay = (remoteDisplay: string): string =>
  repositoryPresentationFromRemoteDisplay(remoteDisplay).label;

export const projectLatestAt = (
  project: Pick<DesktopProject, "threads" | "lastSeenAt">
): string | null => {
  const timestamps = project.threads
    .map((thread) => thread.latestAt)
    .filter((value): value is string => Boolean(value))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
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
  preserveEmptySelection: boolean,
  now = Date.now()
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
  return projects.find((project) => projectIsActive(project, now))?.id ?? null;
};

export const sortProjects = (projects: DesktopProject[]): DesktopProject[] =>
  [...projects].sort((left, right) => {
    const activityDelta =
      (Date.parse(projectLatestAt(right) ?? "") || 0) -
      (Date.parse(projectLatestAt(left) ?? "") || 0);
    return activityDelta || left.name.localeCompare(right.name);
  });

const enrichProject = (
  project: DesktopProjectGroup,
  metadata: DesktopProjectMetadata | null
): DesktopProject => ({
  ...project,
  threads: project.threads as PersonalDesktopProjectThread[],
  name:
    metadata?.contextKind === "independent"
      ? "Chats"
      : metadata?.displayName || project.name,
  contextKind:
    metadata?.contextKind === "independent" ? "independent" : "project",
  path:
    metadata?.path.projectRoot ?? metadata?.path.cwd ?? project.path ?? null,
  catalogued: Boolean(metadata),
  discoveredAt: metadata?.discoveredAt ?? null,
  lastSeenAt: metadata?.lastSeenAt ?? null,
  localProjectId: metadata?.localProjectId ?? null,
  branch: metadata?.git?.branch ?? null,
  repository: metadata?.repository,
  repositoryRemotes: metadata?.git?.remotes,
  remoteDisplay: metadata?.repository
    ? metadata.repository.anchorDisplay
    : (metadata?.git?.remotes.find((remote) => remote.display)?.display ??
      null),
  isWorktree: metadata?.git?.isWorktree ?? false
});

export const mergeProjectSources = (
  graphProjects: DesktopProjectGroup[],
  metadataProjects: DesktopProjectMetadata[]
): DesktopProject[] => {
  const groups = new Map<string, DesktopProject>();
  const keyFor = (identity: RepositoryIdentity | undefined | null) =>
    identity && identity.kind !== "unresolved" && identity.key
      ? repositoryScopeId(identity)
      : null;
  for (const source of graphProjects) {
    const identity = source.threads.find(
      (thread) => thread.repositoryAssignment?.effective
    )?.repositoryAssignment?.effective;
    // Graph groups are main-owned explicit context. Paths never establish
    // affinity; recorded effective identity is authoritative when present.
    const id = keyFor(identity) ?? source.id;
    const current = groups.get(id);
    if (current) {
      current.threads.push(
        ...(source.threads as PersonalDesktopProjectThread[])
      );
      current.eventCount += source.eventCount;
    } else
      groups.set(id, {
        ...enrichProject(
          {
            ...source,
            id,
            name: id === "unassigned" ? "Unresolved history" : source.name
          },
          null
        ),
        repository: identity ?? undefined
      });
  }
  for (const metadata of metadataProjects) {
    const id = keyFor(metadata.repository) ?? metadata.localProjectId;
    const checkout = {
      localProjectId: metadata.localProjectId,
      path: metadata.path.projectRoot ?? metadata.path.cwd,
      repository: metadata.repository
    };
    const current = groups.get(id);
    if (current) {
      const checkouts = [...(current.checkouts ?? []), checkout];
      groups.set(id, {
        ...enrichProject(current, current.catalogued ? null : metadata),
        ...(current.catalogued ? { ...current } : {}),
        checkouts
      });
    } else
      groups.set(id, {
        ...enrichProject(
          {
            id,
            name: metadata.displayName,
            path: checkout.path,
            eventCount: 0,
            threads: []
          },
          metadata
        ),
        checkouts: [checkout]
      });
  }
  for (const project of groups.values()) {
    const recordedCheckouts = project.threads.flatMap((thread) =>
      thread.repositoryAssignment?.automatic
        ? [thread.repositoryAssignment.automatic]
        : []
    );
    const observed = metadataProjects.filter(
      (metadata) =>
        metadata.repository &&
        recordedCheckouts.some(
          (recorded) =>
            recorded.checkoutId === metadata.repository!.checkoutId &&
            recorded.originatingDeviceId ===
              metadata.repository!.originatingDeviceId
        )
    );
    const checkouts = [...(project.checkouts ?? [])];
    for (const metadata of observed)
      if (
        !checkouts.some(
          (checkout) => checkout.localProjectId === metadata.localProjectId
        )
      )
        checkouts.push({
          localProjectId: metadata.localProjectId,
          path: metadata.path.projectRoot ?? metadata.path.cwd,
          repository: metadata.repository
        });
    if (checkouts.length) project.checkouts = checkouts;
  }
  return sortProjects(
    [...groups.values()].map((project) => ({
      ...project,
      threads: [...project.threads].sort(
        (a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt)
      )
    }))
  );
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

const technicalSessionPreviewPatterns = [
  /^tool\s*(call|output)\s*:/i,
  /^status\s*:\s*(completed|failed|running)/i,
  /^input\s*:/i,
  /^\{\s*["']?(cmd|command|path|query)["']?\s*:/i,
  /^<tool/i
];

export const sessionPreview = (
  session: Pick<DesktopThreadGroup, "name" | "sample">
): string => {
  const sample = session.sample.trim().replace(/\s+/g, " ");
  if (
    !sample ||
    technicalSessionPreviewPatterns.some((pattern) => pattern.test(sample))
  ) {
    return "Open the Conversation to review this Captured Session.";
  }
  return sample;
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
