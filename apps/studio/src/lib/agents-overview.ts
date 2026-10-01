import type {
  PersonalAgent,
  PersonalAgentLiveJob
} from "./personal-agents-client";

export type AgentLifecycleFilter = "active" | "retired" | "all";
export const PERSONAL_AGENT_ACTIVITY_LEASE_MS = 3 * 60 * 1_000;

export type ProjectEngagementCardRow = Readonly<{
  id: string;
  name: string;
  status: string | null;
  model: string | null;
  effort: string | null;
}>;

export type ProjectEngagementCard = Readonly<{
  state: "checking" | "unknown" | "unavailable" | "empty" | "available";
  source: "detail" | "summary" | "none";
  projects: readonly ProjectEngagementCardRow[];
  hasMore: boolean;
}>;

export type VerifiedAgentWork = Readonly<{
  status: "unknown" | "idle" | "working";
  count: number | null;
  jobs: PersonalAgent["runningNow"];
  liveJobs: readonly PersonalAgentLiveJob[] | null;
  liveJobsCount: number | null;
  liveJobsTruncated: boolean;
}>;

export function unknownActivityLabel(
  agent: PersonalAgent,
  requestFailed = false,
  now = Date.now()
): "checking" | "unavailable" {
  const summary = agent.activitySummary;
  const summaryUnavailable =
    summary !== undefined &&
    (summary.status === "unknown" ||
      summary.availability !== "available" ||
      !isFreshActivitySummary(summary, now));
  return requestFailed || agent.activityLoaded || summaryUnavailable
    ? "unavailable"
    : "checking";
}

export function filterAgentsByLifecycle(
  agents: readonly PersonalAgent[],
  filter: AgentLifecycleFilter
): PersonalAgent[] {
  if (filter === "all") return [...agents];
  return agents.filter((agent) => agent.lifecycle === filter);
}

/** Uses compact project summaries until a selected detail read loads full data. */
export function projectEngagementsForCard(
  agent: PersonalAgent,
  requestFailed = false
): ProjectEngagementCard {
  const summary = agent.activitySummary?.projectSummary;
  if (summary !== undefined && summary !== null) {
    if (summary.count === 0 && summary.projects.length === 0) {
      return {
        state: "empty",
        source: "summary",
        projects: [],
        hasMore: false
      };
    }
    if (summary.count === null && summary.projects.length === 0) {
      return {
        state: "unknown",
        source: "none",
        projects: [],
        hasMore: false
      };
    }
    const projects = summary.projects.map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status,
      model: null,
      effort: null
    }));
    return {
      state: "available",
      source: "summary",
      projects,
      hasMore:
        summary.truncated ||
        (summary.count !== null && summary.count > projects.length)
    };
  }

  if (agent.activityLoaded) {
    if (agent.stats?.projects === null) {
      return {
        state: "unavailable",
        source: "detail",
        projects: [],
        hasMore: false
      };
    }
    const projects = agent.projects.map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status ?? null,
      model: project.model ?? null,
      effort: project.effort ?? null
    }));
    return {
      state: projects.length === 0 ? "empty" : "available",
      source: "detail",
      projects,
      hasMore: false
    };
  }

  return {
    state: agent.activitySummary
      ? "unknown"
      : requestFailed
        ? "unavailable"
        : "checking",
    source: "none",
    projects: [],
    hasMore: false
  };
}

/** Uses only the service's verified running count and verified live jobs. */
export function verifiedAgentWork(
  agent: PersonalAgent,
  now = Date.now()
): VerifiedAgentWork {
  const summary = agent.activitySummary;
  if (summary) {
    if (
      summary.status === "unknown" ||
      summary.availability !== "available" ||
      !isFreshActivitySummary(summary, now) ||
      summary.runningAttempts === null
    ) {
      return {
        status: "unknown",
        count: null,
        jobs: [],
        liveJobs: null,
        liveJobsCount: null,
        liveJobsTruncated: false
      };
    }
    if (summary.status === "idle" && summary.runningAttempts === 0) {
      return {
        status: "idle",
        count: 0,
        jobs: [],
        liveJobs: null,
        liveJobsCount: null,
        liveJobsTruncated: false
      };
    }
    if (summary.status !== "running" || summary.runningAttempts < 1) {
      return {
        status: "unknown",
        count: null,
        jobs: [],
        liveJobs: null,
        liveJobsCount: null,
        liveJobsTruncated: false
      };
    }
    return {
      status: "working",
      count: summary.runningAttempts,
      jobs: [],
      liveJobs: summary.activeJobs,
      liveJobsCount: summary.activeJobsCount,
      liveJobsTruncated: summary.activeJobsTruncated
    };
  }
  const count = agent.stats?.runningNow ?? null;
  if (!agent.activityLoaded || count === null) {
    return {
      status: "unknown",
      count: null,
      jobs: [],
      liveJobs: null,
      liveJobsCount: null,
      liveJobsTruncated: false
    };
  }
  if (count === 0)
    return {
      status: "idle",
      count: 0,
      jobs: [],
      liveJobs: null,
      liveJobsCount: null,
      liveJobsTruncated: false
    };
  return {
    status: "working",
    count,
    jobs: agent.runningJobsVerified ? agent.runningNow.slice(0, count) : [],
    liveJobs: null,
    liveJobsCount: agent.runningJobsVerified
      ? agent.runningNow.slice(0, count).length
      : 0,
    liveJobsTruncated:
      agent.runningJobsVerified === true && agent.runningNow.length < count
  };
}

function isFreshActivitySummary(
  summary: NonNullable<PersonalAgent["activitySummary"]>,
  now: number
): boolean {
  const countMatchesStatus =
    summary.status === "running"
      ? summary.runningAttempts !== null && summary.runningAttempts > 0
      : summary.status === "idle" && summary.runningAttempts === 0;
  return (
    summary.freshness === "fresh" &&
    summary.observedAt !== null &&
    summary.observedAt <= now &&
    now - summary.observedAt <= PERSONAL_AGENT_ACTIVITY_LEASE_MS &&
    countMatchesStatus
  );
}

/** Drops cached activity assertions after an unsuccessful refresh. */
export function withoutVerifiedActivity(agent: PersonalAgent): PersonalAgent {
  return {
    ...agent,
    activitySummary: agent.activitySummary
      ? {
          ...agent.activitySummary,
          status: "unknown",
          availability: "unavailable",
          freshness: "unknown",
          runningAttempts: null,
          activeJobs: [],
          activeJobsCount: null,
          activeJobsTruncated: false
        }
      : undefined,
    projects: [],
    runningNow: [],
    runningJobsVerified: false,
    highlights: agent.highlights,
    stats: {
      projects: null,
      runningNow: null,
      jobsLogged: agent.stats?.jobsLogged ?? null
    },
    activityLoaded: agent.activityLoaded
  };
}
