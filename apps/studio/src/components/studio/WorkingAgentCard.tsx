import { MapPin } from "lucide-react";
import { AgentAvatarView } from "@/components/AgentAvatarView";
import type {
  PersonalAgent,
  PersonalAgentJob,
  PersonalAgentLiveJob
} from "@/lib/personal-agents-client";
import {
  avatarSpecForAgent,
  goalDiffersFromTitle
} from "./agents-presentation-utils";

type DisplayedJob = Pick<
  PersonalAgentLiveJob,
  "id" | "title" | "goal" | "conversationId" | "projectId" | "projectName"
> & { legacyProjectName: string | null };

export function WorkingAgentCard({
  agent,
  jobs,
  jobCount,
  liveJobs,
  liveJobsCount,
  liveJobsTruncated,
  onOpenProfile,
  onOpenConversation
}: Readonly<{
  agent: PersonalAgent;
  jobs: readonly PersonalAgentJob[];
  jobCount: number;
  liveJobs?: readonly PersonalAgentLiveJob[];
  liveJobsCount?: number | null;
  liveJobsTruncated?: boolean;
  onOpenProfile: () => void;
  onOpenConversation?: (conversationId: string) => void;
}>) {
  const hasLiveJobs = liveJobs !== undefined;
  const displayedJobs: DisplayedJob[] = hasLiveJobs
    ? liveJobs.map((job) => ({
        id: job.id,
        title: job.title,
        goal: job.goal,
        conversationId: job.conversationId,
        projectId: job.projectId,
        projectName: job.projectName,
        legacyProjectName: null
      }))
    : jobs.map((job) => ({
        id: job.id,
        title: job.title,
        goal: job.goal ?? null,
        conversationId: job.conversationId ?? null,
        projectId: job.projectId ?? null,
        projectName: job.projectName ?? null,
        legacyProjectName: job.projectId
          ? (agent.projects.find((project) => project.id === job.projectId)
              ?.name ?? null)
          : null
      }));

  return (
    <article className="rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={`Open ${agent.name} profile`}
          onClick={onOpenProfile}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <AgentAvatarView
            image={agent.avatar?.image}
            spec={avatarSpecForAgent(agent)}
            name={agent.name}
            size="lg"
            className="ring-1 ring-border-strong"
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">
              {agent.name}
            </span>
            <span className="block truncate text-xs text-subtle">
              {agent.role || "Agent"}
            </span>
          </span>
        </button>
        <span className="flex-shrink-0 rounded-full border border-border bg-surface-hover px-2 py-1 text-[10px] font-medium text-subtle">
          Working
          {jobCount > 1 ? ` · ${jobCount}` : ""}
        </span>
      </div>

      {displayedJobs.length === 0 ? (
        <div className="ml-[60px] mt-2 text-xs text-subtle">
          <p>Current Job details are unavailable.</p>
          {hasLiveJobs &&
          liveJobsCount !== null &&
          liveJobsCount !== undefined &&
          liveJobsCount > 0 ? (
            <p className="mt-1">
              Details unavailable for {liveJobsCount} live{" "}
              {liveJobsCount === 1 ? "Job" : "Jobs"}.
            </p>
          ) : hasLiveJobs && liveJobsTruncated ? (
            <p className="mt-1">Some live Job details are unavailable.</p>
          ) : null}
        </div>
      ) : (
        <div className="ml-[60px] mt-1.5 space-y-2">
          {displayedJobs.map((job) => {
            const projectName =
              job.projectName?.trim() || job.legacyProjectName?.trim();
            const location = projectName
              ? projectName
              : job.projectId
                ? "Project unavailable"
                : "Standalone conversation";
            const showGoal = goalDiffersFromTitle(job.goal, job.title);
            return (
              <div
                key={job.id}
                className="border-t border-border pt-2 first:border-t-0 first:pt-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground-secondary">
                    {job.title}
                  </p>
                  {job.conversationId && onOpenConversation && (
                    <button
                      type="button"
                      onClick={() => onOpenConversation(job.conversationId!)}
                      className="flex-shrink-0 text-[11px] font-medium text-subtle underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      Open conversation
                    </button>
                  )}
                </div>
                <p className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-subtle">
                  <MapPin
                    className="h-3 w-3 flex-shrink-0"
                    aria-hidden="true"
                  />
                  <span className="truncate">{location}</span>
                </p>
                {(showGoal || !job.goal?.trim()) && (
                  <p className="mt-1 line-clamp-2 break-words text-[11px] leading-relaxed text-foreground-secondary">
                    {showGoal ? job.goal : "Goal unavailable."}
                  </p>
                )}
              </div>
            );
          })}
          {hasLiveJobs ? (
            liveJobsCount !== null &&
            liveJobsCount !== undefined &&
            liveJobsCount > displayedJobs.length ? (
              <p className="border-t border-border pt-2 text-[11px] text-subtle">
                Details unavailable for {liveJobsCount - displayedJobs.length}{" "}
                more{" "}
                {liveJobsCount - displayedJobs.length === 1 ? "Job" : "Jobs"}.
              </p>
            ) : liveJobsTruncated ? (
              <p className="border-t border-border pt-2 text-[11px] text-subtle">
                Some live Job details are unavailable.
              </p>
            ) : null
          ) : jobCount > displayedJobs.length ? (
            <p className="border-t border-border pt-2 text-[11px] text-subtle">
              Details unavailable for {jobCount - displayedJobs.length} more{" "}
              {jobCount - displayedJobs.length === 1 ? "Job" : "Jobs"}.
            </p>
          ) : null}
        </div>
      )}
    </article>
  );
}
