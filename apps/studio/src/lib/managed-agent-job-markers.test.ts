import { test } from "node:test";
import assert from "node:assert/strict";
import {
  managedAgentJobMarkers
  // @ts-expect-error -- Node's native TypeScript test runner requires the .ts extension.
} from "./managed-agent-job-markers.ts";

test("private planning without a persisted Job shows no Job marker", () => {
  assert.deepEqual(
    managedAgentJobMarkers({ jobs: [] }, { activeAgentName: "Mira" }),
    []
  );
});

test("persisted Jobs render Agent, safe Project name, goal, and actual state", () => {
  assert.deepEqual(
    managedAgentJobMarkers(
      {
        jobs: [
          {
            id: "job-1",
            title: "Prepare the launch checklist",
            projectId: "project-1",
            observedState: "queued",
            createdAt: "2026-01-01T00:00:00.000Z"
          }
        ]
      },
      {
        activeAgentName: "Mira",
        projects: [{ id: "project-1", name: "Launch" }]
      }
    ),
    [
      {
        id: "job-1",
        agentName: "Mira",
        projectName: "Launch",
        goal: "Prepare the launch checklist",
        state: "queued",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  );
});

test("a historical Agent author outranks the current selected Agent", () => {
  const markers = managedAgentJobMarkers(
    {
      jobs: [
        {
          id: "job-1",
          title: "Review the patch",
          projectId: null,
          state: "running"
        }
      ]
    },
    {
      activeAgentName: "Current Agent",
      messages: [{ id: "agent:job-1", author: { name: "Historical Agent" } }]
    }
  );
  assert.equal(markers[0]?.agentName, "Historical Agent");
});
