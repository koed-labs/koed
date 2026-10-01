import type {
  PersonalAgentActivity,
  PersonalAgent,
  PersonalAgentDraftScope,
  PersonalAgentJob,
  PersonalAgentJobPage
} from "./personal-agents-client";

export function unavailablePersonalAgentActivity(
  agentId: string
): PersonalAgentActivity {
  return {
    agentId,
    status: "unknown",
    availability: "unavailable",
    freshness: "unknown",
    observedAt: null,
    runningAttempts: null,
    persistedRunningAttempts: null,
    activeJobs: [],
    activeJobsCount: null,
    activeJobsTruncated: false
  };
}

export function activityForRequestedAgents(
  requestedIds: readonly string[],
  returned: readonly PersonalAgentActivity[]
): PersonalAgentActivity[] {
  const byId = new Map(
    returned.map((activity) => [activity.agentId, activity])
  );
  return requestedIds.map(
    (id) => byId.get(id) ?? unavailablePersonalAgentActivity(id)
  );
}

export function withPersonalAgentActivitySummary(
  agent: PersonalAgent,
  summary: PersonalAgentActivity
): PersonalAgent {
  return { ...agent, activitySummary: summary };
}

function summaryFromDetail(
  agent: PersonalAgent
): PersonalAgentActivity | undefined {
  if (!agent.activityLoaded) return undefined;
  const count = agent.stats?.runningNow ?? null;
  const available = count !== null;
  const liveJobs =
    available && count > 0 && agent.runningJobsVerified
      ? agent.runningNow.slice(0, count).map((job) => ({
          id: job.id,
          title: job.title,
          goal: job.goal ?? null,
          conversationId: job.conversationId ?? null,
          projectId: job.projectId ?? null,
          projectName: job.projectName ?? null,
          state: job.state,
          updatedAt: job.startedAt ?? job.createdAt
        }))
      : [];
  return {
    agentId: agent.id,
    status: !available ? "unknown" : count > 0 ? "running" : "idle",
    availability: available ? "available" : "unavailable",
    freshness: available ? "fresh" : "unknown",
    observedAt: available ? Date.now() : null,
    runningAttempts: available ? count : null,
    persistedRunningAttempts: available ? count : null,
    activeJobs: liveJobs,
    activeJobsCount: available ? count : null,
    activeJobsTruncated: available && liveJobs.length < count
  };
}

export type PersonalAgentReadIdentity = Readonly<{
  agentId: string;
  sequence: number;
  collectionRevision: number;
  scope: PersonalAgentDraftScope | null;
}>;

export function personalAgentReadIsCurrent(
  read: PersonalAgentReadIdentity,
  current: PersonalAgentReadIdentity
): boolean {
  return (
    read.agentId === current.agentId &&
    read.sequence === current.sequence &&
    read.collectionRevision === current.collectionRevision &&
    samePersonalAgentScope(read.scope, current.scope)
  );
}

export function samePersonalAgentScope(
  left: PersonalAgentDraftScope | null,
  right: PersonalAgentDraftScope | null
): boolean {
  if (left === null || right === null) return left === right;
  return left.ownerId === right.ownerId && left.backendId === right.backendId;
}

function mergeJobs(
  newer: readonly PersonalAgentJob[],
  older: readonly PersonalAgentJob[]
): PersonalAgentJob[] {
  const byId = new Map<string, PersonalAgentJob>();
  for (const job of [...newer, ...older]) {
    if (!byId.has(job.id)) byId.set(job.id, job);
  }
  // Keep the server's cursor order. JS timestamps are millisecond precision,
  // while the database cursor can distinguish rows within the same millisecond.
  return [...byId.values()];
}

/** Keeps pages already read while a fresh detail response replaces the head page. */
export function mergePersonalAgentRefresh(
  previous: PersonalAgent | null,
  next: PersonalAgent
): PersonalAgent {
  if (!previous || previous.id !== next.id) return next;
  if (!next.activityLoaded) {
    return {
      ...next,
      projects: previous.projects,
      runningNow: previous.runningNow,
      runningJobsVerified: previous.runningJobsVerified,
      jobs: previous.jobs,
      highlights: previous.highlights,
      stats: previous.stats,
      jobsHasMore: previous.jobsHasMore,
      jobsNextCursor: previous.jobsNextCursor,
      jobsHistoryGapAfterId: previous.jobsHistoryGapAfterId,
      activityLoaded: previous.activityLoaded,
      activitySummary: previous.activitySummary
    };
  }
  const freshTail = next.jobs.at(-1);
  const hasCachedJobs = previous.jobs.length > 0;
  const overlapIndex = freshTail
    ? previous.jobs.findIndex((job) => job.id === freshTail.id)
    : -1;
  const freshTailOverlaps = overlapIndex >= 0;
  const cachedPagesExtendPastHead =
    freshTailOverlaps && overlapIndex < previous.jobs.length - 1;
  const hasHistoryGap =
    next.jobsHasMore &&
    next.jobs.length > 0 &&
    hasCachedJobs &&
    !freshTailOverlaps;
  return {
    ...next,
    jobs: mergeJobs(next.jobs, previous.jobs),
    jobsHasMore:
      next.jobs.length > 0
        ? cachedPagesExtendPastHead || previous.jobsHistoryGapAfterId
          ? previous.jobsHasMore
          : next.jobsHasMore
        : previous.jobsHasMore,
    jobsNextCursor:
      next.jobs.length > 0
        ? cachedPagesExtendPastHead || previous.jobsHistoryGapAfterId
          ? previous.jobsNextCursor
          : (next.jobsNextCursor ?? previous.jobsNextCursor)
        : previous.jobsNextCursor,
    jobsHistoryGapAfterId: previous.jobsHistoryGapAfterId
      ? previous.jobsHistoryGapAfterId
      : hasHistoryGap
        ? (freshTail?.id ?? null)
        : next.jobs.length > 0
          ? null
          : previous.jobsHistoryGapAfterId,
    activitySummary:
      summaryFromDetail(next) ??
      next.activitySummary ??
      previous.activitySummary
  };
}

/** Appends one older page without duplicating overlap from a cursor boundary. */
export function mergePersonalAgentJobPage(
  agent: PersonalAgent,
  page: PersonalAgentJobPage
): PersonalAgent {
  const gapAnchorId = agent.jobsHistoryGapAfterId;
  if (gapAnchorId) {
    const anchorIndex = agent.jobs.findIndex((job) => job.id === gapAnchorId);
    if (anchorIndex >= 0) {
      const head = agent.jobs.slice(0, anchorIndex + 1);
      const tail = agent.jobs.slice(anchorIndex + 1);
      const pageTail = page.jobs.at(-1);
      const pageReachesCachedTail = Boolean(
        pageTail && tail.some((cached) => cached.id === pageTail.id)
      );
      const jobs = mergeJobs(mergeJobs(head, page.jobs), tail);
      return {
        ...agent,
        jobs,
        jobsHasMore: page.hasMore,
        jobsNextCursor: page.nextCursor,
        jobsHistoryGapAfterId:
          page.hasMore && !pageReachesCachedTail
            ? (pageTail?.id ?? gapAnchorId)
            : null
      };
    }
  }
  return {
    ...agent,
    jobs: mergeJobs(agent.jobs, page.jobs),
    jobsHasMore: page.hasMore,
    jobsNextCursor: page.nextCursor,
    jobsHistoryGapAfterId: null
  };
}
