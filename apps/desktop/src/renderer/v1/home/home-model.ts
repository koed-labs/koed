import type { ComponentStatus, KoedServerStatus } from "../../../types.js";
import {
  projectLatestAt,
  type DesktopProject
} from "../../../project-memory-ui.js";
import {
  setupStepsFromStatus,
  type SetupStep
} from "../../views/onboarding/setup-model.js";
import {
  clientDetected,
  clientReady,
  clients,
  type ClientId
} from "../onboarding/model.js";

export type HomeProblem = {
  id: string;
  title: string;
  message: string;
  // Only an existing command that applies to this problem; null means the
  // message is the guidance.
  action: SetupStep["action"];
};

export type HomeView =
  | { kind: "loading" }
  | { kind: "attention"; problems: HomeProblem[]; primary: HomeProblem | null }
  | { kind: "empty"; warnings: HomeProblem[] }
  | { kind: "projects"; warnings: HomeProblem[] };

const unhealthy = ({ state }: ComponentStatus) =>
  state === "needs_attention" || state === "not_configured";

const problemFromStep = (step: SetupStep): HomeProblem => ({
  id: step.id,
  title: step.title,
  message:
    step.components.find(({ status }) => unhealthy(status))?.status.message ??
    step.description,
  action: step.action
});

export const homeProblems = (status: KoedServerStatus): HomeProblem[] => {
  const problems = setupStepsFromStatus(status)
    .filter(
      ({ state }) => state === "needs_attention" || state === "not_configured"
    )
    .map(problemFromStep);
  if (unhealthy(status.captureHook))
    problems.push({
      id: "capture-hook",
      title: "Capture Hook",
      message:
        status.captureHook.message ??
        "New conversations may not be remembered until the Capture Hook is working.",
      action: null
    });
  return problems;
};

// Home can't show Projects without the local API and its database; anything
// else is a warning above the normal content.
const blocking = (status: KoedServerStatus) =>
  status.lifecycle?.state === "stopped" ||
  status.lifecycle?.state === "unavailable" ||
  unhealthy(status.api) ||
  unhealthy(status.database);

export function selectHomeView(
  status: KoedServerStatus | null,
  projects: readonly HomeProjectEntry[] | null
): HomeView {
  if (!status) return { kind: "loading" };
  const problems = homeProblems(status);
  if (blocking(status)) {
    const listed = problems.length
      ? problems
      : [
          {
            id: "services",
            title: "Koed services",
            message: "Koed isn’t running, so your Projects can’t load.",
            action: {
              command: "start",
              label: "Start Koed",
              requiresConsent: false
            }
          } satisfies HomeProblem
        ];
    return {
      kind: "attention",
      problems: listed,
      primary: listed.find(({ action }) => action) ?? null
    };
  }
  if (!projects) return { kind: "loading" };
  return projects.length
    ? { kind: "projects", warnings: problems }
    : { kind: "empty", warnings: problems };
}

export type HomeClient = {
  id: ClientId;
  name: string;
  state: "connected" | "detected" | "unsure" | "attention";
  label: string;
  version: string | null;
};

const clientLabels: Record<HomeClient["state"], string> = {
  connected: "Connected",
  detected: "Detected · not connected",
  unsure: "Status unsure",
  attention: "Needs attention"
};

// Detected or configured AI Clients; a configured client stays listed even
// when detection is unavailable.
export function homeClients(status: KoedServerStatus | null): HomeClient[] {
  if (!status) return [];
  return clients.flatMap(({ id, label: name }) => {
    const client = status.aiClients?.[id];
    if (!client) return [];
    const configured = client.profile.state !== "not_configured";
    const detected = clientDetected(id, status);
    if (!configured && !detected) return [];
    const uncertain =
      client.snapshotState === "stale" || client.snapshotState === "unknown";
    const state: HomeClient["state"] = clientReady(id, status)
      ? "connected"
      : client.profile.state === "needs_attention"
        ? "attention"
        : uncertain
          ? "unsure"
          : configured
            ? "attention"
            : "detected";
    return [
      {
        id,
        name,
        state,
        label: clientLabels[state],
        version: state === "detected" ? client.version : null
      }
    ];
  });
}

export type HomeProjectEntry = {
  id: string;
  name: string;
  // Stored captured events (messages and tool events) for the Project.
  eventCount: number;
  latestAt: string | null;
};

// Matches the sidebar's Project list so a Kin and its sidebar row agree.
export const homeProjectEntries = (
  projects: readonly DesktopProject[]
): HomeProjectEntry[] =>
  projects
    .filter((project) => project.namedProject)
    .map((project) => ({
      id: project.id,
      name: project.name,
      eventCount: project.eventCount,
      latestAt: projectLatestAt(project)
    }));

const time = (value: string | null) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

// Most recent activity first, then name, then id, so equal Projects never swap.
export const rankHomeProjects = (
  entries: readonly HomeProjectEntry[]
): string[] =>
  [...entries]
    .sort(
      (left, right) =>
        time(right.latestAt) - time(left.latestAt) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
    )
    .map(({ id }) => id);

// While held, keep the shown order: drop removed Projects, add new ones last.
export const holdHomeOrder = (
  shown: readonly string[],
  ranked: readonly string[]
): string[] => {
  const present = new Set(ranked);
  const kept = shown.filter((id) => present.has(id));
  const known = new Set(kept);
  return [...kept, ...ranked.filter((id) => !known.has(id))];
};

export const HOME_STAGE_LIMIT = 8;

export function formatHomeAgo(latestAt: string | null, now: number): string {
  const at = time(latestAt);
  if (at === Number.NEGATIVE_INFINITY) return "no activity yet";
  const minutes = Math.max(0, (now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export type HomeHeat = 0 | 1 | 2 | 3;

export function homeHeat(latestAt: string | null, now: number): HomeHeat {
  const minutes = (now - time(latestAt)) / 60_000;
  if (minutes < 5) return 3;
  if (minutes < 60) return 2;
  if (minutes < 1440) return 1;
  return 0;
}
