import { relativeTime, type AgentStatus } from "./collab";

// The "relationship" layer: a mood the live avatar wears based on what the
// agent is doing right now, a title and a plain-language sentence that
// stand in for a single gamified score, and a few milestones worth calling
// out. All of it is derived from data that's already being logged
// (AgentEvent / ChannelJobThread) - nothing new to fake here.
//
// Shared between the Personal side's own agent detail page (full owner
// view) and the Team side's agent workshop (owner controls when it's yours,
// a read-only "spectator" view of the same relationship when it's a
// colleague's) - so the two never drift into two different notions of what
// "Trusted hand" or a milestone badge means.

export function moodExpression(assignments: { status: AgentStatus }[]): string {
  if (assignments.length === 0) return "sleepy";
  if (assignments.some((assignment) => assignment.status === "waiting")) return "curious";
  if (assignments.some((assignment) => assignment.status === "running")) return "happy";
  return "neutral";
}

export function withMoodExpression(spec: Record<string, unknown> | undefined, expression: string) {
  if (!spec) return spec;
  const face = typeof spec.face === "object" && spec.face !== null ? (spec.face as Record<string, unknown>) : {};
  return { ...spec, face: { ...face, expression } };
}

export function tenureTitle(shippedCount: number, createdAt: number): string {
  const days = (Date.now() - createdAt) / 86_400_000;
  if (shippedCount === 0) return "New recruit";
  if (shippedCount < 5 || days < 14) return "Getting acquainted";
  if (shippedCount < 20 || days < 60) return "Trusted hand";
  return "Old hand";
}

export function relationshipNarrative(
  name: string,
  shippedCount: number,
  projectCount: number,
  createdAt: number
): string {
  const joined = `${name} joined ${relativeTime(createdAt)}.`;
  if (shippedCount === 0) {
    return `You and ${name} haven’t shipped anything together yet. ${joined}`;
  }
  const jobsLabel = shippedCount === 1 ? "1 thing" : `${shippedCount} things`;
  const projectsLabel = projectCount === 1 ? "1 project" : `${projectCount} projects`;
  return `You and ${name} have shipped ${jobsLabel} together across ${projectsLabel}. ${joined}`;
}

export function milestonesFor({
  shippedCount,
  projectCount,
  createdAt,
}: {
  shippedCount: number;
  projectCount: number;
  createdAt: number;
}): string[] {
  const days = (Date.now() - createdAt) / 86_400_000;
  const badges: string[] = [];
  if (shippedCount >= 1) badges.push("First job shipped");
  if (shippedCount >= 10) badges.push("10 jobs shipped");
  if (projectCount >= 2) badges.push("Multi-project");
  if (days >= 30) badges.push("One month in");
  return badges;
}
