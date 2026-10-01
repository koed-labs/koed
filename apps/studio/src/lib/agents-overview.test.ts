import { describe, expect, it } from "vitest";
import {
  filterAgentsByLifecycle,
  projectEngagementsForCard,
  unknownActivityLabel,
  verifiedAgentWork,
  withoutVerifiedActivity
} from "./agents-overview";
import type { PersonalAgent } from "./personal-agents-client";

function makeAgent(
  id: string,
  lifecycle: PersonalAgent["lifecycle"],
  runningNow: number | null,
  activityLoaded = true
): PersonalAgent {
  return {
    id,
    ownerId: "owner",
    name: id,
    role: "assistant",
    soul: "",
    lifecycle,
    defaultProvider: null,
    defaultModel: null,
    defaultReasoningEffort: null,
    currentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    retiredAt: lifecycle === "retired" ? 2 : null,
    projects: [],
    runningNow: [],
    jobs: [
      {
        id: "stale-running",
        title: "Old job",
        state: "running",
        createdAt: 1,
        attempts: []
      }
    ],
    highlights: [],
    stats: { projects: 0, runningNow, jobsLogged: 1 },
    jobsHasMore: false,
    jobsNextCursor: null,
    activityLoaded,
    sourceTemplateId: null,
    sourceTemplateVersion: null
  };
}

describe("Agents overview helpers", () => {
  it("filters lifecycle independently from job execution state", () => {
    const agents = [
      makeAgent("active", "active", 0),
      makeAgent("retired", "retired", 0)
    ];

    expect(
      filterAgentsByLifecycle(agents, "active").map((agent) => agent.id)
    ).toEqual(["active"]);
    expect(
      filterAgentsByLifecycle(agents, "retired").map((agent) => agent.id)
    ).toEqual(["retired"]);
    expect(filterAgentsByLifecycle(agents, "all")).toHaveLength(2);
  });

  it("treats unloaded and unavailable counts as unknown despite old running jobs", () => {
    const loading = makeAgent("loading", "active", 0, false);
    const staleLease = makeAgent("stale", "active", null, true);
    expect(verifiedAgentWork(loading)).toEqual({
      status: "unknown",
      count: null,
      jobs: [],
      liveJobs: null,
      liveJobsCount: null,
      liveJobsTruncated: false
    });
    expect(unknownActivityLabel(loading)).toBe("checking");
    expect(verifiedAgentWork(staleLease)).toEqual({
      status: "unknown",
      count: null,
      jobs: [],
      liveJobs: null,
      liveJobsCount: null,
      liveJobsTruncated: false
    });
    expect(unknownActivityLabel(staleLease)).toBe("unavailable");
    expect(unknownActivityLabel(loading, true)).toBe("unavailable");
  });

  it("reports verified zero as idle and positive verified counts as working", () => {
    expect(verifiedAgentWork(makeAgent("idle", "active", 0))).toMatchObject({
      status: "idle",
      count: 0
    });
    expect(verifiedAgentWork(makeAgent("working", "active", 2))).toMatchObject({
      status: "working",
      count: 2,
      jobs: []
    });
  });

  it("exposes job titles only when live job details were explicitly returned", () => {
    const currentJob: PersonalAgent["runningNow"][number] = {
      id: "current-job",
      title: "Review the release",
      state: "running",
      projectId: "project-1",
      createdAt: 2,
      attempts: []
    };
    const verified = {
      ...makeAgent("verified", "active", 1),
      runningNow: [currentJob],
      runningJobsVerified: true
    };
    const legacy = {
      ...makeAgent("legacy", "active", 1),
      runningNow: [currentJob],
      runningJobsVerified: false
    };

    expect(verifiedAgentWork(verified).jobs.map((job) => job.title)).toEqual([
      "Review the release"
    ]);
    expect(verifiedAgentWork(legacy)).toMatchObject({
      status: "working",
      count: 1,
      jobs: []
    });
  });

  it("uses fresh lease summaries and stops treating them as verified after expiry", () => {
    const observedAt = 1_000_000;
    const summary = {
      agentId: "agent",
      status: "running" as const,
      availability: "available" as const,
      freshness: "fresh" as const,
      observedAt,
      runningAttempts: 2,
      persistedRunningAttempts: 2,
      activeJobs: [
        {
          id: "live-job",
          title: "Review changes",
          goal: null,
          conversationId: "conversation-1",
          projectId: "project-1",
          projectName: "Billing",
          state: "running",
          updatedAt: observedAt
        }
      ],
      activeJobsCount: 2,
      activeJobsTruncated: true
    };
    const agent = {
      ...makeAgent("agent", "active", null, false),
      activitySummary: summary
    };

    expect(verifiedAgentWork(agent, observedAt + 1)).toMatchObject({
      status: "working",
      count: 2,
      liveJobs: [{ title: "Review changes" }],
      liveJobsCount: 2,
      liveJobsTruncated: true
    });
    expect(
      verifiedAgentWork(agent, observedAt + 3 * 60 * 1_000 + 1).status
    ).toBe("unknown");
    expect(
      unknownActivityLabel(agent, false, observedAt + 3 * 60 * 1_000 + 1)
    ).toBe("unavailable");
  });

  it("shows named compact project engagements and asks for profile for the rest", () => {
    const agent = {
      ...makeAgent("agent", "active", null, false),
      activitySummary: {
        agentId: "agent",
        status: "idle" as const,
        availability: "available" as const,
        freshness: "fresh" as const,
        observedAt: 100,
        runningAttempts: 0,
        persistedRunningAttempts: 0,
        activeJobs: [],
        activeJobsCount: 0,
        activeJobsTruncated: false,
        projectSummary: {
          projects: [
            {
              id: "project-1",
              name: "Billing",
              status: "active",
              startedAt: 90
            }
          ],
          count: 3,
          truncated: true
        }
      }
    };

    expect(projectEngagementsForCard(agent)).toEqual({
      state: "available",
      source: "summary",
      projects: [
        {
          id: "project-1",
          name: "Billing",
          status: "active",
          model: null,
          effort: null
        }
      ],
      hasMore: true
    });
    expect(agent.activityLoaded).toBe(false);
  });

  it("prefers a newer bulk project summary over cached full-detail card rows", () => {
    const agent = {
      ...makeAgent("agent", "active", 0),
      projects: [
        {
          id: "project-1",
          name: "Old project name",
          status: "active",
          model: "gpt-old",
          effort: "low"
        }
      ],
      activitySummary: {
        agentId: "agent",
        status: "idle" as const,
        availability: "available" as const,
        freshness: "fresh" as const,
        observedAt: 200,
        runningAttempts: 0,
        persistedRunningAttempts: 0,
        activeJobs: [],
        activeJobsCount: 0,
        activeJobsTruncated: false,
        projectSummary: {
          projects: [
            {
              id: "project-1",
              name: "Current project name",
              status: "running",
              startedAt: 190
            }
          ],
          count: 1,
          truncated: false
        }
      }
    };

    expect(projectEngagementsForCard(agent)).toEqual({
      state: "available",
      source: "summary",
      projects: [
        {
          id: "project-1",
          name: "Current project name",
          status: "running",
          model: null,
          effort: null
        }
      ],
      hasMore: false
    });
    expect(agent.activityLoaded).toBe(true);
    expect(agent.projects[0]?.name).toBe("Old project name");
  });

  it("keeps omitted or nameless project summaries unknown instead of idle", () => {
    const base = makeAgent("agent", "active", null, false);
    const omitted = {
      ...base,
      activitySummary: {
        agentId: "agent",
        status: "unknown" as const,
        availability: "unavailable" as const,
        freshness: "unknown" as const,
        observedAt: null,
        runningAttempts: null,
        persistedRunningAttempts: null,
        activeJobs: [],
        activeJobsCount: null,
        activeJobsTruncated: false,
        projectSummary: null
      }
    };
    const nameless = {
      ...base,
      activitySummary: {
        ...omitted.activitySummary,
        projectSummary: { projects: [], count: 2, truncated: false }
      }
    };

    expect(projectEngagementsForCard(omitted).state).toBe("unknown");
    expect(projectEngagementsForCard(nameless)).toMatchObject({
      state: "available",
      source: "summary",
      projects: [],
      hasMore: true
    });
  });

  it("clears cached working and project assertions on refresh failure", () => {
    const failed = withoutVerifiedActivity(makeAgent("agent", "active", 1));
    expect(verifiedAgentWork(failed).status).toBe("unknown");
    expect(failed.projects).toEqual([]);
    expect(failed.runningNow).toEqual([]);
    expect(failed.jobs[0]?.state).toBe("running");
  });
});
