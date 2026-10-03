import type { BuildProgressEvent, BuildProgressEventPage } from "@koed/shared";
import type {
  BuildActivity,
  BuildActivityEvent,
  BuildActivityJob
} from "./studio-build-activity";

export type BuildProgressJobSummary = BuildActivityJob & {
  observedState?: unknown;
  freshness?: unknown;
};

export function buildProgressJobState(value: unknown): BuildActivity["state"] {
  return mapState(value);
}

export function activityWithBuildProgress(input: {
  current: BuildActivity;
  page: BuildProgressEventPage;
  jobs?: BuildProgressJobSummary[];
  projectName?: string;
}): BuildActivity {
  const events = input.page.events.map(mapBuildProgressEvent);
  const latest = events.at(-1);
  const newestJob = input.jobs?.[0];
  const selectedJobId = input.page.jobId;
  const selectedJob = input.jobs?.find((job) => job.id === selectedJobId);
  const mappedJobs = input.jobs?.map((job) => ({
    id: job.id,
    title: job.title,
    state: mapState(job.observedState ?? job.state),
    createdAt: job.createdAt
  }));
  const lastTechnical = [...events]
    .reverse()
    .find((event) => event.technical)?.technical;
  return {
    ...input.current,
    source: "live",
    state:
      latest?.state ??
      mapState(
        selectedJob?.observedState ?? selectedJob?.state ?? newestJob?.state
      ),
    project: {
      ...input.current.project,
      ...(input.projectName ? { name: input.projectName } : {}),
      ...(lastTechnical?.branch ? { branch: lastTechnical.branch } : {}),
      ...(lastTechnical?.status ? { status: lastTechnical.status } : {})
    },
    events,
    updatedAt: latest?.at ?? input.current.updatedAt,
    ...(mappedJobs ? { jobs: mappedJobs } : {}),
    selectedJobId,
    availability: input.page.availability
  };
}

export function unavailableBuildProgress(
  current: BuildActivity,
  reason = "Build progress is temporarily unavailable."
): BuildActivity {
  return {
    ...current,
    source: "live",
    availability: "unavailable",
    events: [
      {
        id: "build-progress-unavailable",
        kind: "message",
        state: current.state,
        story: { title: "Build progress unavailable", detail: reason }
      }
    ]
  };
}

export function mapBuildProgressEvent(
  event: BuildProgressEvent
): BuildActivityEvent {
  const kind: BuildActivityEvent["kind"] =
    event.kind === "input_required"
      ? "input-required"
      : event.kind === "workspace_observed"
        ? "workspace-observed"
        : event.kind;
  return {
    id: event.id,
    at: Date.parse(event.at),
    kind,
    ...(event.state ? { state: event.state } : {}),
    ...(event.story ? { story: event.story } : {}),
    ...(event.technical ? { technical: event.technical } : {}),
    ...(event.attention ? { attention: event.attention } : {})
  };
}

const mapState = (value: unknown): BuildActivity["state"] => {
  if (value === "succeeded" || value === "completed") return "completed";
  if (value === "running") return "running";
  if (value === "waiting" || value === "blocked") return "blocked";
  if (value === "failed") return "failed";
  if (value === "queued") return "idle";
  return "unknown";
};

export function parseBuildProgressPage(
  value: unknown
): BuildProgressEventPage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<BuildProgressEventPage>;
  if (
    typeof candidate.jobId !== "string" ||
    !Array.isArray(candidate.events) ||
    typeof candidate.hasMore !== "boolean" ||
    !(
      candidate.nextCursor === null || typeof candidate.nextCursor === "string"
    ) ||
    !["available", "unavailable", "no_project"].includes(
      String(candidate.availability)
    )
  ) {
    return null;
  }
  return candidate as BuildProgressEventPage;
}
