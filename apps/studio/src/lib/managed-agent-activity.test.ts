import { describe, it, expect } from "vitest";
import { managedAgentActivity } from "./managed-agent-activity";
import { observedBuildTotals } from "./studio-build-activity";
describe("managed agent activity", () => {
  it("keeps the newest headline aligned with the overall state", () => {
    const activity = managedAgentActivity({
      jobs: [
        { id: "new", observedState: "running", freshness: "current" },
        { id: "old", observedState: "succeeded", freshness: "current" }
      ]
    });
    expect(activity.state).toBe("running");
    expect(activity.events.at(-1)?.id).toBe("new");
    expect(activity.events.at(-1)?.story?.title).toBe("Working on your request");
  });
  it("does not call stale persisted work running", () => {
    const activity = managedAgentActivity({
      jobs: [
        {
          id: "job",
          state: "running",
          observedState: "running",
          freshness: "stale"
        }
      ]
    });
    expect(activity.state).toBe("unknown");
    expect(activity.events[0].story?.title).toContain("verification");
  });
  it("shows task completion without inventing code changes", () => {
    const activity = managedAgentActivity({
      jobs: [{ id: "job", observedState: "succeeded", freshness: "current" }]
    });
    expect(activity.state).toBe("completed");
    expect(observedBuildTotals(activity)).toEqual({
      filesChanged: null,
      additions: null,
      deletions: null
    });
  });
});
