import { codexIdePromptUserText } from "./codexIdePrompt";
import { threadSelectionKey } from "./graph";
import type { GraphEvent, ProjectGroup, ThreadGroup } from "./types";

export interface ThreadIndexState {
  readonly projectOrder: string[];
  readonly projectGroupsById: ReadonlyMap<string, ProjectGroup>;
  readonly projectsById: ReadonlyMap<string, ProjectGroup>;
  readonly threadKeysByProjectId: ReadonlyMap<string, string[]>;
  readonly threadsByKey: ReadonlyMap<string, ThreadGroup>;
}

export const emptyThreadIndex = (): ThreadIndexState => ({
  projectOrder: [],
  projectGroupsById: new Map(),
  projectsById: new Map(),
  threadKeysByProjectId: new Map(),
  threadsByKey: new Map()
});

const sameProjectShell = (left: ProjectGroup, right: ProjectGroup) =>
  left.id === right.id &&
  left.name === right.name &&
  left.path === right.path &&
  left.eventCount === right.eventCount;

const sameThreadShell = (left: ThreadGroup, right: ThreadGroup) =>
  left.id === right.id &&
  left.name === right.name &&
  left.projectId === right.projectId &&
  left.projectName === right.projectName &&
  left.eventCount === right.eventCount &&
  left.invalidatedCount === right.invalidatedCount &&
  left.latestAt === right.latestAt &&
  left.sample === right.sample;

const compareGraphEventChronologyDesc = (left: GraphEvent, right: GraphEvent) =>
  right.timestamp.localeCompare(left.timestamp) ||
  (typeof right.sourceSequence === "number" &&
  typeof left.sourceSequence === "number" &&
  right.sourceSequence !== left.sourceSequence
    ? right.sourceSequence - left.sourceSequence
    : typeof left.sourceSequence === "number"
      ? -1
      : typeof right.sourceSequence === "number"
        ? 1
        : right.id.localeCompare(left.id));

const sameStringArray = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const eventSample = (
  event: Pick<GraphEvent, "contentPreview" | "content" | "rawContent">,
  fallback: string
): string =>
  codexIdePromptUserText(
    event.contentPreview ?? event.content ?? event.rawContent ?? fallback
  );

const threadDisplayName = (thread: ThreadGroup): string =>
  codexIdePromptUserText(thread.name) || "Untitled conversation";

const sanitizeThreadShell = (thread: ThreadGroup): ThreadGroup => {
  const name = threadDisplayName(thread);
  const sample = codexIdePromptUserText(thread.sample);
  return name === thread.name && sample === thread.sample
    ? thread
    : { ...thread, name, sample };
};

export function ingestThreadIndex(
  current: ThreadIndexState,
  projects: ProjectGroup[]
): ThreadIndexState {
  const projectOrder = projects.map((project) => project.id);
  const projectGroupsById = new Map<string, ProjectGroup>();
  const projectsById = new Map<string, ProjectGroup>();
  const threadKeysByProjectId = new Map<string, string[]>();
  const threadsByKey = new Map<string, ThreadGroup>();
  let changed = !sameStringArray(current.projectOrder, projectOrder);

  for (const project of projects) {
    const existingProject = current.projectsById.get(project.id);
    const nextProject =
      existingProject && sameProjectShell(existingProject, project)
        ? existingProject
        : {
            id: project.id,
            name: project.name,
            path: project.path,
            eventCount: project.eventCount,
            threads: []
          };
    projectsById.set(project.id, nextProject);
    if (nextProject !== existingProject) {
      changed = true;
    }

    const threadKeys = project.threads.map((thread) =>
      threadSelectionKey(thread)
    );
    const existingThreadKeys =
      current.threadKeysByProjectId.get(project.id) ?? [];
    if (!sameStringArray(existingThreadKeys, threadKeys)) {
      changed = true;
    }
    threadKeysByProjectId.set(project.id, threadKeys);

    for (const thread of project.threads) {
      const sanitizedThread = sanitizeThreadShell(thread);
      const key = threadSelectionKey(sanitizedThread);
      const existingThread = current.threadsByKey.get(key);
      const nextThread =
        existingThread && sameThreadShell(existingThread, sanitizedThread)
          ? existingThread
          : { ...sanitizedThread };
      threadsByKey.set(key, nextThread);
      if (nextThread !== existingThread) {
        changed = true;
      }
    }

    const threads = threadKeys.flatMap(
      (threadKey) => threadsByKey.get(threadKey) ?? []
    );
    const existingProjectGroup = current.projectGroupsById.get(project.id);
    const nextProjectGroup =
      existingProjectGroup &&
      sameProjectShell(existingProjectGroup, project) &&
      sameStringArray(existingThreadKeys, threadKeys) &&
      sameStringArray(
        existingProjectGroup.threads.map((thread) =>
          threadSelectionKey(thread)
        ),
        threadKeys
      ) &&
      threads.every(
        (thread, index) => thread === existingProjectGroup.threads[index]
      )
        ? existingProjectGroup
        : {
            ...nextProject,
            threads
          };
    projectGroupsById.set(project.id, nextProjectGroup);
    if (nextProjectGroup !== existingProjectGroup) {
      changed = true;
    }
  }

  if (!changed) {
    return current;
  }

  return {
    projectOrder,
    projectGroupsById,
    projectsById,
    threadKeysByProjectId,
    threadsByKey
  };
}

export function selectProjectGroups(state: ThreadIndexState): ProjectGroup[] {
  return state.projectOrder.flatMap((projectId) => {
    const project = state.projectGroupsById.get(projectId);
    if (!project) {
      return [];
    }
    return [project];
  });
}

export function selectThread(
  state: ThreadIndexState,
  selectedThreadId: string
): ThreadGroup | undefined {
  if (!selectedThreadId) {
    return undefined;
  }
  const exact = state.threadsByKey.get(selectedThreadId);
  if (exact) {
    return exact;
  }
  for (const thread of state.threadsByKey.values()) {
    if (thread.id === selectedThreadId) {
      return thread;
    }
  }
  return undefined;
}

export function applyThreadEventShellUpdates(
  current: ThreadIndexState,
  thread: ThreadGroup,
  events: GraphEvent[]
): ThreadIndexState {
  const uniqueEvents = [
    ...new Map(events.map((event) => [event.id, event])).values()
  ];
  if (uniqueEvents.length === 0) {
    return current;
  }
  const key = threadSelectionKey(thread);
  const existingThread = current.threadsByKey.get(key);
  const existingProject = current.projectsById.get(thread.projectId);
  const existingProjectGroup = current.projectGroupsById.get(thread.projectId);
  const threadKeys = current.threadKeysByProjectId.get(thread.projectId);
  if (
    !existingThread ||
    !existingProject ||
    !existingProjectGroup ||
    !threadKeys
  ) {
    return current;
  }

  const latestEvent = [...uniqueEvents].sort(
    compareGraphEventChronologyDesc
  )[0];
  const nextThread: ThreadGroup = {
    ...existingThread,
    eventCount: existingThread.eventCount + uniqueEvents.length,
    latestAt:
      latestEvent && latestEvent.timestamp > existingThread.latestAt
        ? latestEvent.timestamp
        : existingThread.latestAt,
    sample:
      latestEvent && latestEvent.timestamp >= existingThread.latestAt
        ? eventSample(latestEvent, existingThread.sample)
        : existingThread.sample
  };
  const nextProject: ProjectGroup = {
    ...existingProject,
    eventCount: existingProject.eventCount + uniqueEvents.length
  };
  const previousThreadPosition = new Map(
    threadKeys.map((threadKey, index) => [threadKey, index])
  );
  const nextThreads = threadKeys
    .flatMap((threadKey) => {
      if (threadKey === key) {
        return [nextThread];
      }
      const indexedThread = current.threadsByKey.get(threadKey);
      return indexedThread ? [indexedThread] : [];
    })
    .sort((left, right) => {
      const latestDifference = right.latestAt.localeCompare(left.latestAt);
      if (latestDifference !== 0) {
        return latestDifference;
      }
      return (
        (previousThreadPosition.get(threadSelectionKey(left)) ?? 0) -
        (previousThreadPosition.get(threadSelectionKey(right)) ?? 0)
      );
    });
  const nextThreadKeys = nextThreads.map((indexedThread) =>
    threadSelectionKey(indexedThread)
  );
  const nextProjectGroup: ProjectGroup = {
    ...nextProject,
    threads: nextThreads
  };
  const projectsById = new Map(current.projectsById);
  const projectGroupsById = new Map(current.projectGroupsById);
  const threadKeysByProjectId = new Map(current.threadKeysByProjectId);
  const threadsByKey = new Map(current.threadsByKey);
  projectsById.set(thread.projectId, nextProject);
  projectGroupsById.set(thread.projectId, nextProjectGroup);
  threadKeysByProjectId.set(thread.projectId, nextThreadKeys);
  threadsByKey.set(key, nextThread);

  return {
    projectOrder: current.projectOrder,
    projectGroupsById,
    projectsById,
    threadKeysByProjectId,
    threadsByKey
  };
}

export function renameThreadShell(
  current: ThreadIndexState,
  thread: ThreadGroup,
  name: string
): ThreadIndexState {
  const key = threadSelectionKey(thread);
  const existingThread = current.threadsByKey.get(key);
  const existingProjectGroup = current.projectGroupsById.get(thread.projectId);
  if (
    !existingThread ||
    !existingProjectGroup ||
    existingThread.name === name
  ) {
    return current;
  }

  const nextThread: ThreadGroup = { ...existingThread, name };
  const nextProjectGroup: ProjectGroup = {
    ...existingProjectGroup,
    threads: existingProjectGroup.threads.map((candidate) =>
      threadSelectionKey(candidate) === key ? nextThread : candidate
    )
  };
  const projectGroupsById = new Map(current.projectGroupsById);
  const threadsByKey = new Map(current.threadsByKey);
  projectGroupsById.set(thread.projectId, nextProjectGroup);
  threadsByKey.set(key, nextThread);

  return {
    ...current,
    projectGroupsById,
    threadsByKey
  };
}

export function visiblePrewarmCandidates(
  projects: ProjectGroup[],
  selectedThread: ThreadGroup | undefined,
  limit: number
) {
  const candidates: ThreadGroup[] = [];
  const selectedKey = selectedThread ? threadSelectionKey(selectedThread) : "";

  for (const project of projects) {
    for (const thread of project.threads) {
      const key = threadSelectionKey(thread);
      if (key !== selectedKey) {
        candidates.push(thread);
      }
      if (candidates.length >= limit) {
        return candidates;
      }
    }
  }

  return candidates;
}

export function nearbyThreadCandidates(
  projects: ProjectGroup[],
  selectedThread: ThreadGroup | undefined,
  radius: number
) {
  if (!selectedThread) {
    return [];
  }
  const selectedKey = threadSelectionKey(selectedThread);
  const threads = projects.flatMap((project) => project.threads);
  const selectedIndex = threads.findIndex(
    (thread) => threadSelectionKey(thread) === selectedKey
  );
  if (selectedIndex < 0) {
    return [];
  }
  const start = Math.max(0, selectedIndex - radius);
  const end = Math.min(threads.length, selectedIndex + radius + 1);
  return threads
    .slice(start, end)
    .filter((thread) => threadSelectionKey(thread) !== selectedKey);
}
