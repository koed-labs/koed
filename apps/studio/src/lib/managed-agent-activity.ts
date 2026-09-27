import { record } from "./managed-agent-chat";
import type {
  BuildActivity,
  BuildActivityEvent,
  BuildActivityState
} from "./studio-build-activity";

export function managedAgentActivity(
  payload: Record<string, unknown>
): BuildActivity {
  const jobs = (Array.isArray(payload.jobs) ? payload.jobs : [])
    .filter(record)
    .slice(0, 20);
  const events: BuildActivityEvent[] = jobs.flatMap((job) => {
    if (typeof job.id !== "string") return [];
    const observed = job.freshness === "stale" ? "unknown" : job.observedState;
    const state: BuildActivityState =
      observed === "succeeded"
        ? "completed"
        : observed === "running"
          ? "running"
          : observed === "failed"
            ? "failed"
            : observed === "queued"
              ? "idle"
              : observed === "canceled"
                ? "idle"
                : "unknown";
    const title =
      observed === "succeeded"
        ? "Task completed"
        : observed === "running"
          ? "Working on your request"
          : observed === "queued"
            ? "Task queued"
            : observed === "canceled"
              ? "Task canceled"
              : observed === "failed"
                ? "Task failed"
                : "Task status needs verification";
    const at =
      typeof job.updatedAt === "string" ? Date.parse(job.updatedAt) : NaN;
    return [
      {
        id: job.id,
        ...(Number.isFinite(at) ? { at } : {}),
        kind:
          state === "completed"
            ? "completed"
            : state === "failed"
              ? "failed"
              : "progress",
        state,
        story: {
          title,
          detail:
            observed === "succeeded"
              ? "The runtime reported a successful completion."
              : observed === "running"
                ? "The runtime is processing your request."
                : observed === "queued"
                  ? "Your request is waiting for the runtime."
                  : "Status reported by the execution service."
        },
        technical: {
          status: typeof observed === "string" ? observed : "unknown"
        }
      }
    ];
  });
  const timestamp =
    typeof payload.snapshotAt === "string"
      ? Date.parse(payload.snapshotAt)
      : NaN;
  return {
    source: "live",
    state: events[0]?.state ?? "idle",
    // The API returns newest first; the panel renders chronological events.
    events: events.reverse(),
    ...(Number.isFinite(timestamp) ? { updatedAt: timestamp } : {})
  };
}
