import type { AgentStatus } from "@/lib/collab";
import { moodExpression, withMoodExpression } from "@/lib/agentRelationship";
import type { PersonalAgent } from "@/lib/personal-agents-client";

export function avatarSpecForAgent(agent: PersonalAgent) {
  const spec = agent.avatar?.spec;
  if (!spec || !agent.activityLoaded || agent.stats?.projects === null)
    return spec;
  const activity: { status: AgentStatus }[] = agent.projects.flatMap(
    (project) =>
      project.status === "waiting" || project.status === "running"
        ? [{ status: project.status }]
        : []
  );
  if (agent.runningNow.length > 0) activity.push({ status: "running" });
  return withMoodExpression(spec, moodExpression(activity));
}

export function statusLabel(status: string | null | undefined): string {
  if (status === "running") return "Working";
  if (status === "waiting") return "Waiting on owner";
  if (status === "queued") return "Queued";
  if (status === "failed") return "Failed";
  if (status === "canceled") return "Canceled";
  if (status === "interrupted") return "Interrupted";
  if (status === "succeeded") return "Completed";
  return "Unknown";
}

export function jobStatusLabel(status: string | null | undefined): string {
  return status === "running" ? "Running (last recorded)" : statusLabel(status);
}

export function settingLabel(value: string | null | undefined): string {
  return value?.trim() || "Unknown";
}

export function goalDiffersFromTitle(
  goal: string | null | undefined,
  title: string
): boolean {
  if (!goal?.trim()) return false;
  const normalize = (value: string) =>
    value
      .trim()
      .toLocaleLowerCase()
      .replace(/[\p{P}\p{S}\s]/gu, "");
  return normalize(goal) !== normalize(title);
}

export function elapsedLabel(startedAt: number, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
