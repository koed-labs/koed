import { describe, expect, it } from "vitest";
import {
  filterAgentsByLifecycle,
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
      jobs: []
    });
    expect(unknownActivityLabel(loading)).toBe("checking");
    expect(verifiedAgentWork(staleLease)).toEqual({
      status: "unknown",
      count: null,
      jobs: []
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

  it("clears cached working and project assertions on refresh failure", () => {
    const failed = withoutVerifiedActivity(makeAgent("agent", "active", 1));
    expect(verifiedAgentWork(failed).status).toBe("unknown");
    expect(failed.projects).toEqual([]);
    expect(failed.runningNow).toEqual([]);
    expect(failed.jobs[0]?.state).toBe("running");
  });
});
