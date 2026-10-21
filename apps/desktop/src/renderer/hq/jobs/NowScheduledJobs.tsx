import { ChevronDown, Clock3, RotateCw } from "lucide-react";
import { useState } from "react";
import type { ScheduledJobInventory } from "./use-scheduled-jobs.js";
import { sortedScheduledJobs } from "./scheduled-jobs-model.js";
import type { Agent } from "@koed/shared/agent-contract";
import { Pixelkin } from "../agents/Pixelkin.js";
import "./scheduled-jobs.css";

const time = (date: Date) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);

const scheduleText = (job: ScheduledJobInventory["jobs"][number]) => {
  const { schedule } = job;
  if (schedule.kind === "daily") return `Every day at ${schedule.at}`;
  if (schedule.kind === "weekdays") return `Every weekday at ${schedule.at}`;
  if (schedule.kind === "weekly")
    return `Weekly on ${schedule.dow.join(", ")} at ${schedule.at}`;
  return `Monthly on day ${schedule.dom} at ${schedule.at}`;
};

export function NowScheduledJobs({
  inventory,
  onOpenJob,
  agents = []
}: {
  inventory: ScheduledJobInventory;
  onOpenJob: (sessionId: string, projectId: string | null) => Promise<boolean>;
  agents?: readonly Agent[];
}) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [navigationError, setNavigationError] = useState(false);
  const rows = sortedScheduledJobs(inventory.jobs);
  const upcoming = rows.filter((entry) => entry.next);
  return (
    <section className="hq-now__scheduled" aria-label="Scheduled Jobs">
      <button
        type="button"
        className="hq-now__scheduled-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Clock3 aria-hidden="true" />
        <span>
          {inventory.loading
            ? "Checking Scheduled Jobs…"
            : inventory.error
              ? "Scheduled Jobs unavailable. Open to retry."
              : upcoming.length
                ? `${inventory.truncated ? "Next among loaded Jobs" : "Next"}: ${upcoming
                    .slice(0, 2)
                    .map(({ job, next }) => `${job.title} ${time(next!)}`)
                    .join(
                      " · "
                    )}${upcoming.length > 2 ? ` · +${upcoming.length - 2}` : ""}`
                : rows.length
                  ? "Scheduled Jobs are paused"
                  : "No scheduled jobs. Try “every weekday at 8, brief me on AI news”."}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {inventory.truncated ? (
        <p role="status" className="hq-now__scheduled-partial">
          Some Scheduled Jobs or runs are not shown.
        </p>
      ) : null}
      {open ? (
        <div className="hq-now__scheduled-list">
          {inventory.error ? <p role="alert">{inventory.error}</p> : null}
          {navigationError ? (
            <p role="alert">
              Job Conversation could not be opened. Refresh and try again.
            </p>
          ) : null}
          {inventory.truncated ? (
            <p role="status">
              Some older Scheduled Jobs or runs are not shown.
            </p>
          ) : null}
          {rows.slice(0, more ? undefined : 5).map(({ job, next }) => (
            <div key={job.id} className="hq-now__scheduled-row">
              {agents.find((agent) => agent.id === job.agentId) ? (
                <Pixelkin
                  agent={agents.find((agent) => agent.id === job.agentId)!}
                  size={18}
                />
              ) : (
                <Clock3 aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={() =>
                  void onOpenJob(job.conversationSessionId, job.projectId)
                    .then((opened) => setNavigationError(!opened))
                    .catch(() => setNavigationError(true))
                }
              >
                <strong>{job.title}</strong>
                <small>
                  {scheduleText(job)} ·{" "}
                  {job.paused
                    ? "paused"
                    : next
                      ? `next ${time(next)}`
                      : "Next run unavailable"}
                </small>
              </button>
            </div>
          ))}
          {rows.length > 5 ? (
            <button
              type="button"
              className="hq-now__more"
              onClick={() => setMore(!more)}
            >
              {more ? "Show less" : `Show ${rows.length - 5} more`}
            </button>
          ) : null}
          {inventory.error || inventory.truncated ? (
            <button
              type="button"
              className="hq-now__scheduled-refresh"
              onClick={() => void inventory.refresh()}
            >
              <RotateCw aria-hidden="true" /> Refresh Scheduled Jobs
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
