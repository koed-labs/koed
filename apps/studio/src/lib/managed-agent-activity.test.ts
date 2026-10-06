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
        {
          id: "reply",
          role: "assistant",
          content: "**Created [index.html](index.html)**"
        }
      ]
    },
    directRuntime
  );
  expect(activity.state).toBe("completed");
  expect(activity.events[0].story).toMatchObject({
    title: "Agent reports: Created index.html",
    detail: "Request: Create a Hello world page\nReply: Created index.html"
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

it("does not label the next task's response as the current task's result", () => {
  const activity = managedConversationActivity(
    {
      executionGeneration: 1,
      jobs: [],
      messages: [
        { id: "prompt", role: "user", content: "First task" },
        { id: "response", role: "assistant", content: "Created first.html" },
        { id: "next", role: "user", content: "Second task" },
        {
          id: "next-response",
          role: "assistant",
          content: "Deleted another file"
        }
      ]
    },
    directRuntime
  );
  expect(activity.events[0].story?.title).toBe(
    "Agent reports: Created first.html"
  );
  expect(activity.events[0].technical?.files).toBeUndefined();
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

it("keeps the last five exchanges, in order, and survives a reload", () => {
  const messages = Array.from({ length: 8 }, (_, index) => [
    { id: `user-${index}`, role: "user", content: `Request ${index}` },
    { id: `reply-${index}`, role: "assistant", content: `Finished ${index}` }
  ]).flat();
  const runtime = {
    ...directRuntime,
    latestCommand: {
      ...directRuntime.latestCommand!,
      clientUserMessageId: "user-7"
    }
  };
  const payload = { executionGeneration: 1, messages };
  const first = managedConversationActivity(payload, runtime);
  expect(first.events).toHaveLength(5);
  expect(first.events.map((event) => event.story?.title)).toEqual(
    [3, 4, 5, 6, 7].map((index) => `Agent reports: Finished ${index}`)
  );
  expect(first.events[0].story?.detail).toBe(
    "Request: Request 3\nReply: Finished 3"
  );
  expect(managedConversationActivity(payload, runtime)).toEqual(first);
});
it("keeps conversation history available alongside named Agent activity", () => {
  const activity = managedConversationActivity(
    {
      executionGeneration: 1,
      jobs: [{ id: "job", observedState: "succeeded" }],
      messages: [
        { id: "prompt", role: "user", content: "Make a page" },
        { id: "reply", role: "assistant", content: "Created the page" }
      ]
    },
    directRuntime
  );
  expect(activity.recentExchanges?.at(-1)?.story?.title).toBe(
    "Agent reports: Created the page"
  );
});
