import { expect, it } from "vitest";
import type { RuntimeSnapshot, RuntimeItem } from "./managed-agent-chat";
import type { BuildActivity } from "./studio-build-activity";
import {
  managedChatProgress,
  managedChatProgressHistory,
  teamRequestProgress
} from "./agent-chat-progress";
import type { TeamAgentRequest } from "@koed/shared/team-agent-requests";

const runtime = (
  state = "dispatching",
  items: RuntimeItem[] = []
): RuntimeSnapshot => ({
  execution: {
    id: "chat",
    projectId: null,
    provider: "codex",
    aiClientInstanceId: "codex.default",
    model: "model",
    reasoningEffort: "medium",
    permissionMode: "full_access",
    executionGeneration: 2,
    stateVersion: 1,
    state: "running",
    lastErrorCode: null
  },
  latestCommand: {
    id: "turn",
    commandKind: "prompt",
    state,
    lastErrorCode: null
  },
  items
});
it("distinguishes sending, queued, working, uncertain and terminal states", () => {
  expect(managedChatProgress(null, true)?.state).toBe("sending");
  expect(managedChatProgress(runtime("queued"))?.state).toBe("queued");
  expect(managedChatProgress(runtime())?.state).toBe("working");
  expect(managedChatProgress(runtime(), true)?.state).toBe("working");
  expect(managedChatProgress(runtime("indeterminate"))?.state).toBe(
    "uncertain"
  );
  for (const state of ["completed", "failed", "canceled"])
    expect(managedChatProgress(runtime(state))).toBeNull();
  expect(managedChatProgress(null)).toBeNull();
  expect(
    managedChatProgress({
      ...runtime(),
      execution: { ...runtime().execution, state: "stopped" }
    })
  ).toBeNull();
});
it("ignores hidden reasoning and stale output; recognizes approved streaming and input requests", () => {
  const item: RuntimeItem = {
    id: "output",
    executionGeneration: 2,
    itemKind: "transient_output",
    state: "pending",
    payload: { text: "Private reasoning" },
    presentation: {
      mode: "hidden",
      renderer: "message",
      policyKey: "reasoning"
    }
  };
  expect(managedChatProgress(runtime("dispatching", [item]))).toMatchObject({
    state: "working",
    steps: []
  });
  const visible = {
    ...item,
    payload: { text: "Public reply" },
    presentation: {
      mode: "expanded",
      renderer: "message",
      policyKey: "transient_output"
    }
  };
  expect(managedChatProgress(runtime("dispatching", [visible]))?.state).toBe(
    "responding"
  );
  expect(
    managedChatProgress(
      runtime("dispatching", [{ ...visible, executionGeneration: 1 }])
    )?.state
  ).toBe("working");
  expect(
    managedChatProgress(
      runtime("dispatching", [
        {
          ...item,
          itemKind: "user_input",
          presentation: { mode: "expanded", renderer: "user_input" }
        }
      ])
    )?.state
  ).toBe("waiting");
});
it("uses only bounded explicit phases from a running live Job", () => {
  const activity: BuildActivity = {
    source: "live",
    state: "running",
    selectedJobId: "job",
    jobs: [{ id: "job", title: "Task", state: "running" }],
    events: Array.from({ length: 9 }, (_, index) => ({
      id: String(index),
      kind: "phase",
      story: { title: `Step ${index}`, detail: "Agent-reported progress" }
    }))
  };
  expect(managedChatProgress(runtime(), false, activity)).toMatchObject({
    label: "Step 8",
    steps: expect.any(Array)
  });
  expect(managedChatProgress(runtime(), false, activity)?.steps).toHaveLength(
    5
  );
  expect(
    managedChatProgress(runtime(), false, { ...activity, source: "demo" })
      ?.steps
  ).toEqual([]);
  expect(
    managedChatProgress(runtime(), false, {
      ...activity,
      jobs: [{ ...activity.jobs![0]!, state: "completed" }]
    })?.steps
  ).toEqual([]);
});
it("keeps Team feedback to shared status and stops when the assignment finishes", () => {
  const request = {
    id: "request",
    status: "accepted",
    agentName: "Alice",
    jobStatus: "running"
  } as TeamAgentRequest;
  expect(teamRequestProgress(request)).toMatchObject({
    state: "working",
    steps: []
  });
  expect(teamRequestProgress({ ...request, jobStatus: "waiting" })?.state).toBe(
    "waiting"
  );
  expect(
    teamRequestProgress({ ...request, jobStatus: "succeeded" })
  ).toBeNull();
  expect(
    teamRequestProgress({ ...request, status: "awaiting_owner" })
  ).toBeNull();
});

it("uses public summaries for the active turn and retains completed snapshots after reload", () => {
  const item: RuntimeItem = {
    id: "progress",
    executionGeneration: 2,
    itemKind: "transient_output",
    state: "pending",
    presentation: {
      mode: "expanded",
      renderer: "message",
      policyKey: "transient_output"
    },
    payload: {
      publicProgress: true,
      commandId: "turn",
      clientUserMessageId: "user-message",
      steps: [
        { id: "summary", title: "Thinking", detail: "Checking project files" }
      ]
    }
  };
  expect(
    managedChatProgress(runtime("running", [item]))?.steps[0]?.detail
  ).toBe("Checking project files");
  const completed = managedChatProgressHistory(
    runtime("completed", [{ ...item, state: "resolved" }])
  );
  expect(completed[0]).toMatchObject({
    state: "completed",
    userMessageId: "user-message",
    steps: [{ detail: "Checking project files" }]
  });
  expect(
    managedChatProgressHistory(
      runtime("completed", [
        {
          ...item,
          presentation: {
            mode: "hidden",
            renderer: "message",
            policyKey: "hidden"
          }
        }
      ])
    )
  ).toEqual([]);
  expect(
    managedChatProgressHistory(
      runtime("running", [
        { ...item, payload: { text: "raw private reasoning" } }
      ])
    )
  ).toEqual([]);
});
