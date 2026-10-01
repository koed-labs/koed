import { MapPin } from "lucide-react";
import { AgentAvatarView } from "@/components/AgentAvatarView";
import type {
  PersonalAgent,
  PersonalAgentJob
} from "@/lib/personal-agents-client";
import {
  avatarSpecForAgent,
  goalDiffersFromTitle
} from "./agents-presentation-utils";

export function WorkingAgentCard({
  agent,
  jobs,
  jobCount,
  onOpenProfile,
  onOpenConversation
}: Readonly<{
  agent: PersonalAgent;
  jobs: readonly PersonalAgentJob[];
  jobCount: number;
  onOpenProfile: () => void;
  onOpenConversation?: (conversationId: string) => void;
}>) {
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

      {jobs.length === 0 ? (
        <p className="ml-[60px] mt-2 text-xs text-subtle">
          Current Job details are unavailable.
        </p>
      ) : (
        <div className="ml-[60px] mt-1.5 space-y-2">
          {jobs.map((job) => {
            const projectName =
              job.projectName?.trim() ||
              (job.projectId
                ? agent.projects.find((project) => project.id === job.projectId)
                    ?.name
                : null);
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
          {jobCount > jobs.length && (
            <p className="border-t border-border pt-2 text-[11px] text-subtle">
              Details unavailable for {jobCount - jobs.length} more{" "}
              {jobCount - jobs.length === 1 ? "Job" : "Jobs"}.
            </p>
          )}
        </div>
      )}
    </article>
  );
}
