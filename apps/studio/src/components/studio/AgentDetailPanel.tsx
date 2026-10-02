import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Archive, Award, Copy, Pencil, Sparkles, X } from "lucide-react";
import { AgentAvatarView } from "@/components/AgentAvatarView";
import { Tooltip } from "@/components/Tooltip";
import { relativeTime } from "@/lib/collab";
import {
  milestonesFor,
  relationshipNarrative,
  tenureTitle
} from "@/lib/agentRelationship";
import type {
  PersonalAgent,
  PersonalAgentJob
} from "@/lib/personal-agents-client";
import {
  avatarSpecForAgent,
  elapsedLabel,
  jobStatusLabel,
  settingLabel,
  statusLabel
} from "./agents-presentation-utils";

export function AgentDetailPanel({
  agent,
  loading,
  error,
  jobsLoading,
  jobsError,
  onLoadMoreJobs,
  onClose,
  onGiveAJob,
  onOpenConversation,
  clockNow,
  onEdit,
  onRetire,
  onClone,
  onRestore,
  cloneLoading,
  restoring,
  lifecycleError,
  teamAvailability
}: {
  agent: PersonalAgent;
  loading: boolean;
  error: string | null;
  jobsLoading: boolean;
  jobsError: string | null;
  onLoadMoreJobs: () => void;
  onClose: () => void;
  onGiveAJob?: () => void;
  onOpenConversation?: (conversationId: string) => void;
  clockNow: number;
  onEdit: () => void;
  onRetire: () => void;
  onClone: () => void;
  onRestore: () => void;
  cloneLoading: boolean;
  restoring: boolean;
  lifecycleError: string | null;
  teamAvailability?: ReactNode;
}) {
  const [soulOpen, setSoulOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const completedJobs = agent.jobs.filter((job) => job.state === "succeeded");
  const runningNow = agent.stats
    ? agent.stats.runningNow
    : agent.runningNow.length;
  const projectCount = agent.stats
    ? agent.stats.projects
    : agent.projects.length;
  const jobsLogged = agent.stats ? agent.stats.jobsLogged : agent.jobs.length;
  const jobHistoryComplete = !agent.jobsHasMore;
  const personalDefaults = [
    agent.defaultProvider && agent.defaultModel
      ? `${agent.defaultProvider} · ${agent.defaultModel}`
      : null,
    agent.defaultReasoningEffort
  ].filter((value): value is string => Boolean(value));
  const canSummarizeRelationship =
    !loading &&
    agent.activityLoaded &&
    jobHistoryComplete &&
    projectCount !== null;
  const relationshipTitle = canSummarizeRelationship
    ? tenureTitle(completedJobs.length, agent.createdAt)
    : null;
  const narrative = canSummarizeRelationship
    ? relationshipNarrative(
        agent.name,
        completedJobs.length,
        projectCount ?? agent.projects.length,
        agent.createdAt
      )
    : null;
  const milestones =
    canSummarizeRelationship && projectCount !== null
      ? milestonesFor({
          shippedCount: completedJobs.length,
          projectCount: projectCount ?? agent.projects.length,
          createdAt: agent.createdAt
        })
      : [];
  const moodSpec = avatarSpecForAgent(agent);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, [agent.id]);

  return (
    <aside
      aria-label={`${agent.name} details`}
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto border-t border-border bg-background no-drag xl:w-[380px] xl:flex-none xl:border-l xl:border-t-0"
    >
      <div className="flex items-start justify-between gap-2 px-5 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatarView
            image={agent.avatar?.image}
            spec={moodSpec}
            name={agent.name}
            size="xl"
            className="ring-1 ring-border-strong"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-lg font-semibold text-foreground">
                {agent.name}
              </p>
              {agent.lifecycle === "retired" && (
                <span className="text-[10px] font-medium uppercase tracking-wide text-subtle">
                  Retired
                </span>
              )}
            </div>
            <p className="truncate text-sm text-subtle">{agent.role}</p>
            <p className="mt-0.5 truncate text-[11px] text-faint">
              Created {relativeTime(agent.createdAt)}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-faint">
              {personalDefaults.length > 0
                ? `Personal defaults · ${personalDefaults.join(" · ")}`
                : "No personal model defaults"}
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {agent.lifecycle === "active" ? (
            <>
              <Tooltip content="Edit agent">
                <button
                  type="button"
                  className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
                  onClick={onEdit}
                  aria-label="Edit agent"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              <Tooltip content="Retire agent">
                <button
                  type="button"
                  className="rounded-md p-1.5 text-subtle hover:bg-warning/10 hover:text-warning"
                  onClick={onRetire}
                  aria-label="Retire agent"
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </>
          ) : (
            <Tooltip content="Restore this agent">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[11px] font-medium text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
                onClick={onRestore}
                disabled={restoring}
              >
                {restoring ? "Restoring…" : "Restore"}
              </button>
            </Tooltip>
          )}
          <Tooltip content="Clone this profile">
            <button
              type="button"
              className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground-secondary disabled:opacity-50"
              onClick={onClone}
              aria-label="Clone agent"
              disabled={cloneLoading}
            >
              {cloneLoading ? (
                <span className="px-1 text-[10px]">…</span>
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
          <Tooltip content="Close">
            <button
              ref={closeButtonRef}
              type="button"
              className="rounded-md p-1.5 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
      </div>

      {agent.lifecycle === "active" && onGiveAJob && (
        <div className="mt-4 px-5">
          <button
            type="button"
            onClick={onGiveAJob}
            disabled={loading}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" />
            Give a job
          </button>
        </div>
      )}

      {lifecycleError && (
        <p role="alert" className="mt-3 px-5 text-xs text-danger">
          {lifecycleError}
        </p>
      )}

      <div className="mt-4 px-5">
        <span className="rounded-full bg-chip px-2.5 py-1 text-[11px] font-medium text-chip-foreground">
          {relationshipTitle ??
            (completedJobs.length && jobHistoryComplete
              ? "Working relationship"
              : "New recruit")}
        </span>
        <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">
          {narrative ??
            (completedJobs.length && jobHistoryComplete
              ? `You and ${agent.name} have completed ${completedJobs.length} ${completedJobs.length === 1 ? "job" : "jobs"} together.`
              : agent.jobsHasMore
                ? `Recent jobs are recorded for ${agent.name}; older history is available from the service.`
                : `${agent.name} has no completed jobs recorded yet.`)}
        </p>
        {milestones.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {milestones.map((milestone) => (
              <span
                key={milestone}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-1 text-[11px] font-medium text-foreground-secondary"
              >
                <Award className="h-3 w-3 text-subtle" />
                {milestone}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 px-5">
        <StatTile
          label="Projects"
          value={loading || !agent.activityLoaded ? "—" : (projectCount ?? "—")}
        />
        <StatTile
          label="Running now"
          value={loading || !agent.activityLoaded ? "—" : (runningNow ?? "—")}
        />
        <StatTile
          label="Jobs logged"
          value={loading || !agent.activityLoaded ? "—" : (jobsLogged ?? "—")}
        />
      </div>

      {loading ? (
        error ? (
          <p className="mt-6 px-5 text-sm text-danger">{error}</p>
        ) : (
          <p className="mt-6 px-5 text-sm text-subtle">
            Loading verified activity…
          </p>
        )
      ) : !agent.activityLoaded ? (
        <p className="mt-6 px-5 text-sm text-danger">
          {error ??
            "Activity history is unavailable. No local activity has been substituted."}
        </p>
      ) : (
        <>
          {error && (
            <p className="mt-4 px-5 text-xs text-warning">
              Live refresh unavailable. Showing the last verified activity.
            </p>
          )}
          <section className="mt-6 px-5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
              Active in{" "}
              {projectCount !== null && projectCount > 0 && `(${projectCount})`}
            </p>
            {projectCount === null ? (
              <p className="mt-2 text-sm text-subtle">
                Project engagements are unavailable from the service.
              </p>
            ) : agent.projects.length === 0 ? (
              <p className="mt-2 text-sm text-subtle">
                Not active in any project.
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {agent.projects.map((project) => (
                  <div
                    key={project.id}
                    className="rounded-lg border border-border bg-surface p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-foreground">
                        {project.name}
                      </p>
                      <span className="flex-shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-muted">
                        {statusLabel(project.status)}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-subtle">
                      {project.focus || "No active focus recorded."}
                    </p>
                    <p className="mt-2 text-[11px] text-subtle">
                      {settingLabel(project.model)} ·{" "}
                      {settingLabel(project.effort)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mt-6 px-5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">
              <Sparkles className="h-3 w-3" /> Running Now
            </p>
            {runningNow === null ? (
              <p className="mt-2 text-sm text-subtle">
                Current running activity is unavailable from the service.
              </p>
            ) : agent.runningNow.length === 0 ? (
              <p className="mt-2 text-sm text-subtle">
                No verified jobs running now.
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {agent.runningNow.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    detailed
                    now={clockNow}
                    onOpenConversation={onOpenConversation}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="mt-6 px-5">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">
              <Award className="h-3 w-3" /> Highlights
            </p>
            {agent.highlights.length === 0 ? (
              <p className="mt-2 text-sm text-subtle">
                No verified completed highlights yet.
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {agent.highlights.map((highlight) => (
                  <div
                    key={highlight.id}
                    className="rounded-lg border border-border bg-surface p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-foreground">
                        {highlight.title}
                      </p>
                      <span className="flex-shrink-0 text-[11px] text-subtle">
                        {relativeTime(highlight.at)}
                      </span>
                    </div>
                    {highlight.projectName && (
                      <p className="mt-0.5 text-[11px] text-subtle">
                        {highlight.projectName}
                      </p>
                    )}
                    {highlight.summary && (
                      <p className="mt-2 text-xs text-foreground-secondary">
                        {highlight.summary}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mt-6 px-5 pb-5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">
              Job history
            </p>
            {agent.jobsHasMore && (
              <p className="mt-2 text-xs text-warning">
                Showing recorded Jobs. Older history is available.
              </p>
            )}
            {agent.jobs.length === 0 && !agent.jobsHasMore ? (
              <p className="mt-2 text-sm text-subtle">
                {jobsLogged === null
                  ? "Job history is unavailable from the service."
                  : jobsLogged === 0
                    ? "No jobs recorded yet."
                    : "Job details are unavailable from the service."}
              </p>
            ) : (
              <div className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
                {agent.jobs.length === 0 && (
                  <p className="text-sm text-subtle">
                    No Jobs are available on this page.
                  </p>
                )}
                {agent.jobs.map((job) => (
                  <Fragment key={job.id}>
                    <JobCard
                      job={job}
                      detailed
                      now={clockNow}
                      onOpenConversation={onOpenConversation}
                    />
                    {job.id === agent.jobsHistoryGapAfterId && (
                      <p className="border-y border-dashed border-border py-2 text-center text-[11px] text-warning">
                        Some older Jobs are still loading in this history.
                      </p>
                    )}
                  </Fragment>
                ))}
                {agent.jobsHasMore && agent.jobsNextCursor && (
                  <div className="border-t border-border pt-3">
                    {jobsError && (
                      <p role="alert" className="mb-2 text-xs text-danger">
                        {jobsError}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={onLoadMoreJobs}
                      disabled={jobsLoading}
                      className="w-full rounded-md border border-border bg-surface px-3 py-2 text-xs font-medium text-foreground-secondary hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60"
                    >
                      {jobsLoading
                        ? agent.jobsHistoryGapAfterId
                          ? "Loading missing Jobs…"
                          : "Loading older Jobs…"
                        : jobsError
                          ? agent.jobsHistoryGapAfterId
                            ? "Retry loading missing Jobs"
                            : "Retry loading older Jobs"
                          : agent.jobsHistoryGapAfterId
                            ? "Load missing Jobs"
                            : "Load more older Jobs"}
                    </button>
                  </div>
                )}
                {agent.jobsHasMore && !agent.jobsNextCursor && (
                  <p className="border-t border-border pt-3 text-xs text-warning">
                    Older Job history is currently unavailable.
                  </p>
                )}
              </div>
            )}
          </section>
        </>
      )}
      {teamAvailability}
      <div className="mt-6 px-5 pb-5">
        <button
          type="button"
          aria-expanded={soulOpen}
          aria-controls="agent-soul-preview"
          className="flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-subtle hover:text-foreground-secondary"
          onClick={() => setSoulOpen((open) => !open)}
        >
          soul.md · identity
          <span className="text-foreground-secondary">
            {soulOpen ? "Hide" : "Show"}
          </span>
        </button>
        {soulOpen && (
          <pre
            id="agent-soul-preview"
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-3 text-[11px] leading-relaxed text-muted"
          >
            {agent.soul || "No soul instructions were returned by the service."}
          </pre>
        )}
      </div>
    </aside>
  );
}

function JobCard({
  job,
  detailed = false,
  now,
  onOpenConversation
}: {
  job: PersonalAgentJob;
  detailed?: boolean;
  now: number;
  onOpenConversation?: (conversationId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-foreground">
          {job.title}
        </p>
        <span className="flex-shrink-0 text-[11px] text-subtle">
          {relativeTime(job.completedAt ?? job.startedAt ?? job.createdAt)}
        </span>
      </div>
      {job.projectName && (
        <p className="mt-0.5 text-[11px] text-subtle">{job.projectName}</p>
      )}
      {job.agentName && (
        <p className="mt-0.5 text-[11px] text-subtle">
          Agent profile · {job.agentName}
          {job.agentVersion !== null && job.agentVersion !== undefined
            ? ` · v${job.agentVersion}`
            : ""}
        </p>
      )}
      <p className="mt-2 text-[11px] text-subtle">
        {jobStatusLabel(job.state)} · Actual model: {settingLabel(job.model)} ·{" "}
        {settingLabel(job.effort)}
        {job.provider && ` · ${job.provider}`}
      </p>
      {detailed && job.summary && (
        <p className="mt-2 text-xs text-foreground-secondary">{job.summary}</p>
      )}
      {detailed && job.goal && (
        <div className="mt-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
            Job goal
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground-secondary">
            {job.goal}
          </p>
        </div>
      )}
      {detailed && job.state === "running" && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-subtle">
            {job.startedAt
              ? `Elapsed ${elapsedLabel(job.startedAt, now)}`
              : "Elapsed time unavailable"}
          </p>
          {job.conversationId && onOpenConversation ? (
            <button
              type="button"
              onClick={() => onOpenConversation(job.conversationId!)}
              className="text-[11px] font-medium text-accent underline underline-offset-2"
            >
              Open running Conversation
            </button>
          ) : null}
        </div>
      )}
      {job.attempts.length > 0 && (
        <details className="mt-3 border-t border-border pt-2">
          <summary className="cursor-pointer text-[11px] font-medium text-subtle hover:text-foreground-secondary">
            Attempts ({job.attempts.length})
          </summary>
          <div className="mt-2 space-y-2">
            {job.attempts.map((attempt) => (
              <div key={attempt.id} className="rounded-md bg-background/60 p-2">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-medium text-foreground-secondary">
                    Attempt {attempt.attemptNumber}
                  </span>
                  <span className="text-subtle">
                    {jobStatusLabel(attempt.status)}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-subtle">
                  {settingLabel(attempt.provider)} ·{" "}
                  {settingLabel(attempt.model)} · {settingLabel(attempt.effort)}
                  {attempt.instanceId && ` · ${attempt.instanceId}`}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-2 py-2 text-center">
      <p className="text-lg font-semibold text-foreground">{value}</p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-subtle">
        {label}
      </p>
    </div>
  );
}
