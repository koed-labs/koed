import { describe, expect, it } from "vitest";
import {
  activityForRequestedAgents,
  mergePersonalAgentJobPage,
  mergePersonalAgentRefresh,
  personalAgentReadIsCurrent,
  withPersonalAgentActivitySummary
} from "./personal-agent-activity";
import type {
  PersonalAgent,
  PersonalAgentActivity,
  PersonalAgentJob
} from "./personal-agents-client";

function job(id: string, createdAt: number): PersonalAgentJob {
  return { id, title: id, state: "succeeded", createdAt, attempts: [] };
}

function agent(jobs: PersonalAgentJob[]): PersonalAgent {
  return {
    id: "agent",
    ownerId: "owner",
    name: "Agent",
    role: "reviewer",
    soul: "",
    lifecycle: "active",
    defaultProvider: null,
    defaultModel: null,
    defaultReasoningEffort: null,
    currentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    retiredAt: null,
    projects: [],
    runningNow: [],
    runningJobsVerified: false,
    jobs,
    highlights: [],
    stats: { projects: 0, runningNow: 0, jobsLogged: 10 },
    jobsHasMore: true,
    jobsNextCursor: "old-head-cursor",
    activityLoaded: true,
    sourceTemplateId: null,
    sourceTemplateVersion: null
  };
}

const freshActivity: PersonalAgentActivity = {
  agentId: "agent",
  status: "idle",
  availability: "available",
  freshness: "fresh",
  observedAt: 10,
  runningAttempts: 0,
  persistedRunningAttempts: 0,
  activeJobs: [],
  activeJobsCount: 0,
  activeJobsTruncated: false
};

describe("personal Agent activity and history state", () => {
  it("marks missing aggregate rows unknown instead of inferring idle", () => {
    const complete = activityForRequestedAgents(
      ["agent", "missing"],
      [freshActivity]
    );

    expect(complete[0]).toEqual(freshActivity);
    expect(complete[1]).toMatchObject({
      agentId: "missing",
      status: "unknown",
      availability: "unavailable",
      freshness: "unknown",
      runningAttempts: null
    });
  });

  it("updates lightweight activity without replacing selected detail or loaded history", () => {
    const detailed = agent([
      job("history-head", 100),
      job("history-older", 90)
    ]);
    const next = withPersonalAgentActivitySummary(detailed, {
      ...freshActivity,
      status: "unknown",
      availability: "unsupported",
      freshness: "unknown",
      runningAttempts: null
    });

    expect(next.jobs.map((item) => item.id)).toEqual([
      "history-head",
      "history-older"
    ]);
    expect(next.stats).toEqual(detailed.stats);
    expect(next.activityLoaded).toBe(true);
    expect(next.activitySummary?.status).toBe("unknown");
  });

  it("rejects activity results after sequence, collection, or owner scope changes", () => {
    const read = {
      agentId: "agent",
      sequence: 2,
      collectionRevision: 4,
      scope: { ownerId: "owner-1", backendId: "backend-1" }
    };

    expect(personalAgentReadIsCurrent(read, { ...read })).toBe(true);
    expect(personalAgentReadIsCurrent(read, { ...read, sequence: 3 })).toBe(
      false
    );
    expect(
      personalAgentReadIsCurrent(read, { ...read, collectionRevision: 5 })
    ).toBe(false);
    expect(
      personalAgentReadIsCurrent(read, {
        ...read,
        scope: { ownerId: "owner-2", backendId: "backend-1" }
      })
    ).toBe(false);
  });

  it("keeps service cursor order when refreshing a history head with overlap", () => {
    const previous = agent([job("old-head", 100), job("old-page", 90)]);
    const next = {
      ...previous,
      jobs: [job("new-head", 110), job("old-head", 100)],
      jobsHasMore: true,
      jobsNextCursor: "fresh-head-cursor"
    };

    const merged = mergePersonalAgentRefresh(previous, next);
    expect(merged.jobs.map((item) => item.id)).toEqual([
      "new-head",
      "old-head",
      "old-page"
    ]);
    expect(merged.jobsNextCursor).toBe("old-head-cursor");
    expect(merged.jobsHasMore).toBe(true);
    expect(merged.jobsHistoryGapAfterId).toBeNull();
  });

  it("replaces a prior bulk summary with current selected detail activity", () => {
    const previous = {
      ...agent([job("history", 100)]),
      activitySummary: {
        ...freshActivity,
        status: "idle" as const,
        runningAttempts: 0
      }
    };
    const next = {
      ...previous,
      runningNow: [
        {
          ...job("live", 120),
          state: "running",
          conversationId: "conversation",
          goal: "Review the current change"
        }
      ],
      runningJobsVerified: true,
      stats: { projects: 1, runningNow: 1, jobsLogged: 4 },
      activityLoaded: true
    };

    const refreshed = mergePersonalAgentRefresh(previous, next);
    expect(refreshed.activitySummary).toMatchObject({
      status: "running",
      availability: "available",
      freshness: "fresh",
      runningAttempts: 1,
      activeJobs: [
        {
          id: "live",
          conversationId: "conversation",
          goal: "Review the current change"
        }
      ]
    });
  });

  it("inserts unseen gap pages before retained older pages after a no-overlap refresh", () => {
    const previous = agent([job("cached-old-a", 80), job("cached-old-b", 70)]);
    const fresh = {
      ...previous,
      jobs: [job("new-a", 120), job("new-b", 110)],
      jobsHasMore: true,
      jobsNextCursor: "gap-page-1"
    };
    const refreshed = mergePersonalAgentRefresh(previous, fresh);
    expect(refreshed.jobs.map((item) => item.id)).toEqual([
      "new-a",
      "new-b",
      "cached-old-a",
      "cached-old-b"
    ]);
    expect(refreshed.jobsHistoryGapAfterId).toBe("new-b");

    const refreshedAgain = mergePersonalAgentRefresh(refreshed, {
      ...refreshed,
      jobs: [job("newest", 130), job("new-a", 120), job("new-b", 110)],
      jobsHasMore: true,
      jobsNextCursor: "second-fresh-head"
    });
    expect(refreshedAgain.jobsHistoryGapAfterId).toBe("new-b");
    expect(refreshedAgain.jobsNextCursor).toBe("gap-page-1");

    const firstGapPage = mergePersonalAgentJobPage(refreshedAgain, {
      jobs: [job("gap-a", 100), job("gap-b", 90)],
      hasMore: true,
      nextCursor: "gap-page-2"
    });
    expect(firstGapPage.jobs.map((item) => item.id)).toEqual([
      "newest",
      "new-a",
      "new-b",
      "gap-a",
      "gap-b",
      "cached-old-a",
      "cached-old-b"
    ]);
    expect(firstGapPage.jobsHistoryGapAfterId).toBe("gap-b");

    const bridgePage = mergePersonalAgentJobPage(firstGapPage, {
      jobs: [job("cached-old-a", 80), job("cached-old-b", 70)],
      hasMore: true,
      nextCursor: "older-page"
    });
    expect(bridgePage.jobs.map((item) => item.id)).toEqual([
      "newest",
      "new-a",
      "new-b",
      "gap-a",
      "gap-b",
      "cached-old-a",
      "cached-old-b"
    ]);
    expect(bridgePage.jobsHistoryGapAfterId).toBeNull();
  });

  it("preserves old loaded pages when a detail refresh has no jobs", () => {
    const previous = agent([job("head", 100), job("older", 90)]);
    const next = {
      ...previous,
      jobs: [],
      jobsHasMore: false,
      jobsNextCursor: null
    };
    const merged = mergePersonalAgentRefresh(previous, next);

    expect(merged.jobs.map((item) => item.id)).toEqual(["head", "older"]);
    expect(merged.jobsHasMore).toBe(true);
    expect(merged.jobsNextCursor).toBe("old-head-cursor");
  });
});
