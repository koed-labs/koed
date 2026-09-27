import assert from "node:assert/strict";
import test from "node:test";
// Node 24's native TypeScript runner requires the source extension here.
// @ts-expect-error -- Next's app compiler does not enable TS extension imports.
import { buildHomeViewModel, classifyHomeDestination, filterHomeCollections, homeDestinationUnavailableReason, homeProjects } from "./studio-home.ts";
import type { HomeExecution, HomeRecent, HomeRequest } from "./studio-contract";

const recent = (
  id: string,
  projectId: string | null,
  projectName: string
): HomeRecent => ({
  id,
  sessionId: `session-${id}`,
  projectId,
  projectName,
  title: id,
  provider: "client",
  updatedAt: "2026-09-21T00:00:00.000Z"
});

const execution = (id: string, projectId: string | null): HomeExecution => ({
  id,
  sessionId: null,
  projectId,
  title: id,
  provider: "client",
  state: "running",
  updatedAt: "2026-09-21T00:00:00.000Z",
  error: null
});

test("keeps projects with duplicate names distinct and includes execution-only projects", () => {
  const projects = homeProjects(
    [
      recent("recent-a", "project-a", "Shared name"),
      recent("recent-b", "project-b", "Shared name")
    ],
    [execution("execution-c", "project-c")]
  );

  assert.deepEqual(projects, [
    { id: "project-a", name: "Shared name" },
    { id: "project-b", name: "Shared name" },
    { id: "project-c", name: "project-c" }
  ]);
});

test("filters all collections by project ID and excludes ID-less records", () => {
  const requests: HomeRequest[] = [
    {
      id: "request-a",
      executionId: "execution-a",
      sessionId: null,
      title: "A",
      kind: "approval",
      updatedAt: "2026-09-21T00:00:00.000Z"
    },
    {
      id: "request-b",
      executionId: "execution-b",
      sessionId: null,
      title: "B",
      kind: "approval",
      updatedAt: "2026-09-21T00:00:00.000Z"
    }
  ];
  const filtered = filterHomeCollections(
    {
      executions: [
        execution("execution-a", "project-a"),
        execution("execution-b", null)
      ],
      requests,
      recents: [
        recent("recent-a", "project-a", "A"),
        recent("recent-unknown", null, "A")
      ]
    },
    "project-a"
  );

  assert.deepEqual(
    filtered.executions.map((item) => item.id),
    ["execution-a"]
  );
  assert.deepEqual(
    filtered.requests.map((item) => item.id),
    ["request-a"]
  );
  assert.deepEqual(
    filtered.recents.map((item) => item.id),
    ["recent-a"]
  );
});

test("builds workflow destinations from runtime state and excludes recent graph threads", () => {
  const failed: HomeExecution = {
    ...execution("execution-failed", "project-a"),
    state: "failed",
    error: "The agent stopped before completing the task."
  };
  const request: HomeRequest = {
    id: "request-a",
    executionId: "execution-running",
    sessionId: "captured-session",
    title: "Approve the next command",
    kind: "command approval",
    updatedAt: "2026-09-21T00:00:00.000Z"
  };
  const view = buildHomeViewModel({
    executions: [
      execution("execution-running", "project-a"),
      failed
    ],
    requests: [request],
    recents: [recent("captured-thread", "project-a", "Captured thread")]
  });

  assert.deepEqual(
    view.map((item) => item.id),
    ["request-request-a", "failure-execution-failed", "running-execution-running"]
  );
  assert.deepEqual(
    view.map((item) => item.destination.type),
    ["agent-decision", "agent-review", "agent-review"]
  );
  assert.equal(view.some((item) => item.id.includes("captured")), false);
  assert.ok(view.every((item) => item.action === "Unavailable"));
  assert.ok(
    view.every((item) => item.disabledReason.endsWith("not connected in Studio yet."))
  );
  assert.equal(view[0]?.destination.type, "agent-decision");
  if (view[0]?.destination.type === "agent-decision") {
    assert.equal(view[0].destination.executionId, "execution-running");
    assert.equal(view[0].destination.requestId, "request-a");
  }
});

test("supports only explicitly source-backed future change briefings", () => {
  const view = buildHomeViewModel(
    { executions: [], requests: [], recents: [] },
    [
      {
        id: "briefing-a",
        projectId: "project-a",
        projectName: "Project A",
        title: "Authentication approach changed",
        detail: "Source-backed detail supplied by a future preparation path.",
        updatedAt: "2026-09-21T00:00:00.000Z",
        source: { id: "source-a", revision: "revision-2" }
      }
    ]
  );

  assert.equal(view.length, 1);
  assert.deepEqual(view[0]?.destination, {
    type: "change-briefing",
    briefingId: "briefing-a",
    projectId: "project-a",
    sourceId: "source-a",
    sourceRevision: "revision-2"
  });
  assert.equal(
    view[0]?.disabledReason,
    "Change briefings are not connected in Studio yet."
  );
});

test("keeps destination unavailability reasons typed by workflow", () => {
  const classification = classifyHomeDestination({
    type: "agent-review",
    executionId: "execution-a"
  });
  assert.equal(classification.available, false);
  assert.deepEqual(classification.destination, {
    type: "agent-review",
    executionId: "execution-a"
  });
  assert.equal(
    homeDestinationUnavailableReason({ type: "chat", chatId: "chat-a" }),
    "Chat is not connected in Studio yet."
  );
  assert.equal(
    homeDestinationUnavailableReason({
      type: "collaborative-thread",
      threadId: "thread-a",
      projectId: null
    }),
    "Collaborative threads are not connected in Studio yet."
  );
  assert.equal(
    homeDestinationUnavailableReason({
      type: "agent-decision",
      executionId: "execution-a",
      requestId: "request-a"
    }),
    "Agent decisions are not connected in Studio yet."
  );
  assert.equal(
    homeDestinationUnavailableReason({ type: "agent-review", executionId: "execution-a" }),
    "Agent review is not connected in Studio yet."
  );
});
