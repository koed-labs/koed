import type { PersonalAgent } from "./personal-agents-client";

export type AgentLifecycleFilter = "active" | "retired" | "all";

export type VerifiedAgentWork = Readonly<{
  status: "unknown" | "idle" | "working";
  count: number | null;
  jobs: PersonalAgent["runningNow"];
}>;

export function unknownActivityLabel(
  agent: PersonalAgent,
  requestFailed = false
): "checking" | "unavailable" {
  return requestFailed || agent.activityLoaded ? "unavailable" : "checking";
}

export function filterAgentsByLifecycle(
  agents: readonly PersonalAgent[],
  filter: AgentLifecycleFilter
): PersonalAgent[] {
  if (filter === "all") return [...agents];
  return agents.filter((agent) => agent.lifecycle === filter);
}

/** Uses only the service's verified running count and verified live jobs. */
export function verifiedAgentWork(agent: PersonalAgent): VerifiedAgentWork {
  const count = agent.stats?.runningNow ?? null;
  if (!agent.activityLoaded || count === null) {
    return { status: "unknown", count: null, jobs: [] };
  }
  if (count === 0) return { status: "idle", count: 0, jobs: [] };
  return {
    status: "working",
    count,
    jobs: agent.runningJobsVerified ? agent.runningNow.slice(0, count) : []
  };
}

/** Drops cached activity assertions after an unsuccessful refresh. */
export function withoutVerifiedActivity(agent: PersonalAgent): PersonalAgent {
  return {
    ...agent,
    projects: [],
    runningNow: [],
    runningJobsVerified: false,
    highlights: [],
    stats: {
      projects: null,
      runningNow: null,
      jobsLogged: agent.stats?.jobsLogged ?? null
    },
    activityLoaded: false
  };
}
