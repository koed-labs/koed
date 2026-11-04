import type { HistoricalIngestionLifecycle } from "@koed/shared/historical-ingestion-progress";
import type { ComponentStatus, KoedServerStatus } from "../../../types.js";
import {
  projectLatestAt,
  type DesktopProject
} from "../../../project-memory-ui.js";
import {
  setupStepsFromStatus,
  type SetupStep
} from "../../views/onboarding/setup-model.js";
import { aiClientHealth } from "../client-health.js";
import { clients, type ClientId } from "../onboarding/model.js";

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
  | { kind: "ingesting"; warnings: HomeProblem[]; ingestion: HomeIngestion }
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
    // The health step repeats the last diagnostics run, which may be stale;
    // Home reports the live components instead.
    .filter(
      ({ id, state }) =>
        id !== "health" &&
        (state === "needs_attention" || state === "not_configured")
    )
    .map(problemFromStep);
  for (const { id, label } of clients) {
    const health = aiClientHealth(id, status);
    if (!health.needsAttention) continue;
    problems.push({
      id: `client-${id}`,
      title: label,
      message: health.description,
      action: {
        command: `repair_${id}`,
        label: `Repair ${label}`,
        requiresConsent: true
      }
    });
  }
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
    // While Koed is stopped every component reports that; one row with the
    // real fix beats a list of symptoms.
    const stopped =
      status.lifecycle?.state === "stopped" ||
      status.lifecycle?.state === "unavailable";
    const listed =
      problems.length && !stopped
        ? problems
        : [
            {
              id: "services",
              title: "Koed services",
              message:
                "Koed isn’t running. Starting it brings your Projects back.",
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
  const ingestion = homeIngestion(status);
  for (const client of ingestion.clients) {
    if (!client.stuck) continue;
    problems.push({
      id: `ingestion-${client.id}`,
      title: `${client.name} history isn’t progressing`,
      message: `Processing recent ${client.name} history keeps failing (${client.lastErrorCode ?? "unknown error"}). New conversations are still captured.`,
      action: {
        command: "doctor",
        label: "Run diagnostics",
        requiresConsent: false
      }
    });
  }
  if (ingestion.active)
    return { kind: "ingesting", warnings: problems, ingestion };
  if (!projects) return { kind: "loading" };
  return projects.length
    ? { kind: "projects", warnings: problems }
    : { kind: "empty", warnings: problems };
}

export type HomeIngestionClient = {
  id: ClientId;
  name: string;
  lifecycle: HistoricalIngestionLifecycle;
  selected: number | null;
  completed: number;
  skipped: number;
  lastErrorCode: string | null;
  // Failing with no progress for HOME_STUCK_MS: retries alone won't fix it.
  stuck: boolean;
};

export const HOME_STUCK_MS = 10 * 60 * 1_000;

export type HomeIngestion = {
  // Running or retrying; idle and unknown never hold Home on this screen.
  active: boolean;
  clients: HomeIngestionClient[];
  // Finished Conversations (completed or skipped) out of the selection; the
  // total is null until every listed client knows its selection.
  finished: number;
  selected: number | null;
};

export function homeIngestion(
  status: KoedServerStatus,
  now = Date.now()
): HomeIngestion {
  const listed = clients.flatMap(({ id, label: name }) => {
    const progress = status.historicalIngestion?.[id];
    if (!progress || progress.lifecycle === "unknown") return [];
    return [
      {
        id,
        name,
        lifecycle: progress.lifecycle,
        selected: progress.selected,
        completed: progress.completed,
        skipped: progress.skipped,
        lastErrorCode: progress.lastErrorCode,
        stuck:
          progress.lifecycle === "failed" &&
          progress.failingSince !== null &&
          now - Date.parse(progress.failingSince) >= HOME_STUCK_MS
      }
    ];
  });
  return {
    active: listed.some(
      ({ lifecycle }) => lifecycle === "running" || lifecycle === "failed"
    ),
    clients: listed,
    finished: listed.reduce(
      (sum, client) => sum + client.completed + client.skipped,
      0
    ),
    selected: listed.every(({ selected }) => selected !== null)
      ? listed.reduce((sum, client) => sum + (client.selected ?? 0), 0)
      : null
  };
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
// when detection is unavailable. Health matches Settings via aiClientHealth.
export function homeClients(status: KoedServerStatus | null): HomeClient[] {
  if (!status) return [];
  return clients.flatMap(({ id, label: name }) => {
    const health = aiClientHealth(id, status);
    if (!health.installed && !health.configured) return [];
    const snapshot = status.aiClients?.[id]?.snapshotState;
    const state: HomeClient["state"] = !health.configured
      ? "detected"
      : health.needsAttention
        ? "attention"
        : snapshot === "stale" || snapshot === "unknown"
          ? "unsure"
          : "connected";
    return [
      {
        id,
        name,
        state,
        label: state === "attention" ? health.description : clientLabels[state],
        // "2.1.312 (Claude Code)" repeats the name beside it.
        version:
          state === "detected"
            ? (health.version?.replace(/\s*\(.*\)$/, "") ?? null)
            : null
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

export const HOME_STAGE_LIMIT = 7;

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
