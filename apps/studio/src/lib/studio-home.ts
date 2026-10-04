import type { HomeExecution, HomeRecent, HomeRequest } from "./studio-contract";
// Node 24's native TypeScript runner requires the source extension here.
// @ts-expect-error -- Next's app compiler does not enable TS extension imports.
import { isSyntheticIndependentProject } from "./project-identity.ts";

export type HomeProject = {
  id: string;
  name: string;
};

export type HomeCollections = {
  executions: HomeExecution[];
  requests: HomeRequest[];
  recents: HomeRecent[];
};

/** Destinations are workflow identities, not identifiers for captured memory. */
export type HomeWorkflowDestination =
  | { type: "chat"; chatId: string }
  | {
      type: "collaborative-thread";
      threadId: string;
      projectId: string | null;
    }
  | { type: "agent-decision"; executionId: string; requestId: string }
  | { type: "agent-review"; executionId: string }
  | {
      type: "change-briefing";
      briefingId: string;
      projectId: string | null;
      sourceId: string;
      sourceRevision: string;
    };

export type SourceBackedChangeBriefing = {
  id: string;
  projectId: string | null;
  projectName?: string;
  title: string;
  detail: string;
  updatedAt: string;
  source: { id: string; revision: string };
};

export type HomeViewItem = {
  id: string;
  title: string;
  detail: string;
  kicker: string;
  action: string;
  urgency: "now" | "soon" | "idle";
  projectId: string | null;
  projectName?: string;
  destination: HomeWorkflowDestination;
  disabledReason: string;
};

const DESTINATION_UNAVAILABLE: Record<HomeWorkflowDestination["type"], string> =
  {
    chat: "Chat is not connected in Studio yet.",
    "collaborative-thread":
      "Collaborative threads are not connected in Studio yet.",
    "agent-decision": "Agent decisions are not connected in Studio yet.",
    "agent-review": "Agent review is not connected in Studio yet.",
    "change-briefing": "Change briefings are not connected in Studio yet."
  };

export type HomeDestinationClassification = {
  destination: HomeWorkflowDestination;
  available: false;
  disabledReason: string;
};

export function classifyHomeDestination(
  destination: HomeWorkflowDestination
): HomeDestinationClassification {
  return {
    destination,
    available: false,
    disabledReason: DESTINATION_UNAVAILABLE[destination.type]
  };
}

export function homeDestinationUnavailableReason(
  destination: HomeWorkflowDestination
) {
  return classifyHomeDestination(destination).disabledReason;
}

function uniqueById<T extends { id: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && seen.add(item.id));
}

export function belongsToProject(
  item: { projectId: string | null },
  projectId: string | null
) {
  return projectId === null ? true : item.projectId === projectId;
}

export function filterHomeCollections(
  collections: HomeCollections,
  projectId: string | null
): HomeCollections {
  const executions = uniqueById(collections.executions).filter((item) =>
    belongsToProject(item, projectId)
  );
  const executionIds = new Set(executions.map((item) => item.id));
  return {
    executions,
    requests: uniqueById(collections.requests).filter(
      (item) => projectId === null || executionIds.has(item.executionId)
    ),
    recents: uniqueById(collections.recents).filter((item) =>
      belongsToProject(item, projectId)
    )
  };
}

export function homeProjects(
  recents: HomeRecent[],
  executions: HomeExecution[],
  registeredProjects: HomeProject[] = []
): HomeProject[] {
  const names = new Map<string, string>();
  const projects: HomeProject[] = [];
  const add = (id: string, name: string) => {
    if (!id || projects.some((project) => project.id === id)) return;
    projects.push({ id, name: names.get(id) ?? name });
  };

  for (const recent of uniqueById(recents)) {
    const name = recent.projectName.trim();
    if (
      !recent.projectId ||
      !name ||
      isSyntheticIndependentProject(recent.projectId, name)
    )
      continue;
    names.set(recent.projectId, name);
    add(recent.projectId, recent.projectName);
  }
  for (const project of registeredProjects) {
    if (!project.id || isSyntheticIndependentProject(project.id, project.name))
      continue;
    names.set(project.id, project.name.trim());
    add(project.id, project.name);
  }
  for (const execution of uniqueById(executions)) {
    if (
      !execution.projectId ||
      isSyntheticIndependentProject(execution.projectId) ||
      !names.has(execution.projectId)
    )
      continue;
    add(execution.projectId, names.get(execution.projectId) ?? "Project");
  }

  return projects.map((project) => ({
    ...project,
    name: names.get(project.id) ?? project.name
  }));
}

function normalizedState(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isFailedExecution(item: HomeExecution) {
  return ["failed", "failure", "error", "errored"].includes(
    normalizedState(item.state)
  );
}

function isCurrentExecution(item: HomeExecution) {
  return (
    ["current", "running", "in_progress", "queued", "starting"].includes(
      normalizedState(item.state)
    ) && item.activity !== "idle"
  );
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown time"
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }).format(date);
}

function executionActivityPresentation(item: HomeExecution) {
  switch (item.activity ?? "unknown") {
    case "running":
      return {
        kicker: "Agent review · Active turn",
        detail: `${item.provider} · A prompt is actively running. Updated ${displayTime(item.updatedAt)}.`
      };
    case "pending":
      return {
        kicker: "Agent review · Pending",
        detail: `${item.provider} · A prompt is queued and has not started.`
      };
    case "uncertain":
      return {
        kicker: "Agent review · Status uncertain",
        detail: `${item.provider} · The latest prompt has no confirmed active lease. Open the conversation to check.`
      };
    case "operation":
      return {
        kicker: "Execution · Operation active",
        detail: `${item.provider} · A managed operation is active; this does not confirm an active prompt turn.`
      };
    case "operation-pending":
      return {
        kicker: "Execution · Operation pending",
        detail: `${item.provider} · A managed operation is queued.`
      };
    case "idle":
      return null;
    default:
      return {
        kicker: "Agent review · Activity unverified",
        detail: `${item.provider} · Saved execution state is ${item.state}; current activity could not be verified.`
      };
  }
}

/**
 * Build the actionable shape of Home without reading conversation content.
 * Recents intentionally remain available only for project labels/filtering.
 */
export function buildHomeViewModel(
  collections: HomeCollections,
  changeBriefings: SourceBackedChangeBriefing[] = []
): HomeViewItem[] {
  const executions = uniqueById(collections.executions);
  const requests = uniqueById(collections.requests);
  const projectNames = new Map(
    uniqueById(collections.recents).map((item) => [
      item.projectId,
      item.projectName
    ])
  );
  const requested = new Set(requests.map((item) => item.executionId));
  const items: HomeViewItem[] = [];

  for (const request of requests) {
    const execution = executions.find(
      (item) => item.id === request.executionId
    );
    const destination: HomeWorkflowDestination = {
      type: "agent-decision",
      executionId: request.executionId,
      requestId: request.id
    };
    const classification = classifyHomeDestination(destination);
    items.push({
      id: `request-${request.id}`,
      title: request.title,
      detail: `${request.kind} is waiting for your attention.`,
      kicker: "Agent decision · Needs you",
      action: "Unavailable",
      urgency: "now",
      projectId: execution?.projectId ?? null,
      projectName: execution?.projectId
        ? projectNames.get(execution.projectId)
        : undefined,
      destination,
      disabledReason: classification.disabledReason
    });
  }

  for (const execution of executions.filter(
    (item) => isFailedExecution(item) && !requested.has(item.id)
  )) {
    const destination: HomeWorkflowDestination = {
      type: "agent-review",
      executionId: execution.id
    };
    const classification = classifyHomeDestination(destination);
    items.push({
      id: `failure-${execution.id}`,
      title: execution.title,
      detail: execution.error ?? "Execution failed.",
      kicker: `${execution.provider} · Agent review · Failed`,
      action: "Unavailable",
      urgency: "now",
      projectId: execution.projectId,
      projectName: execution.projectId
        ? projectNames.get(execution.projectId)
        : undefined,
      destination,
      disabledReason: classification.disabledReason
    });
  }

  for (const execution of executions.filter(
    (item) => isCurrentExecution(item) && !requested.has(item.id)
  )) {
    const activity = executionActivityPresentation(execution);
    if (!activity) continue;
    const destination: HomeWorkflowDestination = {
      type: "agent-review",
      executionId: execution.id
    };
    const classification = classifyHomeDestination(destination);
    items.push({
      id: `execution-${execution.id}`,
      title: execution.title,
      detail: activity.detail,
      kicker: activity.kicker,
      action: "Unavailable",
      urgency: "soon",
      projectId: execution.projectId,
      projectName: execution.projectId
        ? projectNames.get(execution.projectId)
        : undefined,
      destination,
      disabledReason: classification.disabledReason
    });
  }

  // The future producer must verify evidence and access before supplying a
  // briefing. A source reference here is not proof that its claim is valid.
  for (const briefing of uniqueById(changeBriefings)) {
    if (!briefing.source.id || !briefing.source.revision) continue;
    const destination: HomeWorkflowDestination = {
      type: "change-briefing",
      briefingId: briefing.id,
      projectId: briefing.projectId,
      sourceId: briefing.source.id,
      sourceRevision: briefing.source.revision
    };
    const classification = classifyHomeDestination(destination);
    items.push({
      id: `briefing-${briefing.id}`,
      title: briefing.title,
      detail: briefing.detail,
      kicker: "Change briefing",
      action: "Unavailable",
      urgency: "idle",
      projectId: briefing.projectId,
      projectName: briefing.projectName,
      destination,
      disabledReason: classification.disabledReason
    });
  }

  return items;
}
