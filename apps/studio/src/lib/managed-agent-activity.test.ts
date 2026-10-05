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
    expect(activity.events.at(-1)?.story?.title).toBe(
      "Working on your request"
    );
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

import { managedConversationActivity } from "./managed-agent-activity";
import type { RuntimeSnapshot } from "./managed-agent-chat";
const directRuntime: RuntimeSnapshot = {
  execution: {
    id: "conversation",
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "test-model",
    reasoningEffort: "medium",
    permissionMode: "full_access",
    projectId: "project",
    executionGeneration: 1,
    stateVersion: 1,
    state: "running",
    lastErrorCode: null
  },
  items: [],
  latestCommand: {
    id: "command",
    clientUserMessageId: "prompt",
    commandKind: "prompt",
    state: "completed",
    lastErrorCode: null,
    updatedAt: "2026-10-05T12:00:00Z"
  }
};
it("shows a direct chat's completed task and verified settings without a named Agent Job", () => {
  const activity = managedConversationActivity(
    {
      executionGeneration: 1,
      jobs: [],
      messages: [
        { id: "prompt", role: "user", content: "Create a Hello world page" },
        { id: "reply", role: "assistant", content: "Created index.html" }
      ]
    },
    directRuntime
  );
  expect(activity.state).toBe("completed");
  expect(activity.events[0].story).toMatchObject({
    title: "Task completed",
    detail: "Request: Create a Hello world page"
  });
  expect(activity.events[0].technical?.execution).toMatchObject({
    model: "test-model",
    reasoning: "medium"
  });
  expect(observedBuildTotals(activity).filesChanged).toBeNull();
  expect(activity.events[0].technical?.files).toBeUndefined();
});
it("does not attach the previous prompt to pending work or reuse a different execution generation", () => {
  const queued = {
    ...directRuntime,
    latestCommand: {
      ...directRuntime.latestCommand!,
      id: "new",
      clientUserMessageId: "new-prompt",
      state: "queued"
    }
  };
  const payload = {
    executionGeneration: 1,
    jobs: [],
    messages: [{ id: "prompt", role: "user", content: "Previous task" }]
  };
  expect(
    managedConversationActivity(payload, queued).events[0].story?.detail
  ).not.toContain("Previous task");
  expect(
    managedConversationActivity(
      {
        ...payload,
        executionGeneration: 0,
        jobs: [{ id: "old", observedState: "running" }]
      },
      directRuntime
    )
  ).toMatchObject({ state: "unknown", events: [] });
});
it.each([
  ["dispatching", "running"],
  ["indeterminate", "unknown"],
  ["failed", "failed"],
  ["canceled", "idle"]
])("maps direct command state %s to %s", (state, expected) => {
  expect(
    managedConversationActivity(
      { executionGeneration: 1, jobs: [] },
      {
        ...directRuntime,
        latestCommand: { ...directRuntime.latestCommand!, state }
      }
    ).state
  ).toBe(expected);
});
