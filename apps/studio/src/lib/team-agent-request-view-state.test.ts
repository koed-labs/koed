import assert from "node:assert/strict";
import test from "node:test";
import type { TeamAgentRequest } from "@koed/shared/team-agent-requests";
const testModulePath = "./team-agent-request-view-state" + ".ts";
const {
  teamAgentRequestCanAccept,
  teamAgentRequestCardActions,
  teamAgentRequestHasTerminalOutcome,
  teamAgentRequestReviewHref,
  teamAgentRequestStatusLabel
} = await import(testModulePath);

const request = (
  overrides: Partial<TeamAgentRequest> = {}
): TeamAgentRequest => ({
  id: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  teamProjectId: "33333333-3333-4333-8333-333333333333",
  channelId: "44444444-4444-4444-8444-444444444444",
  requestMessageId: "55555555-5555-4555-8555-555555555555",
  originRootMessageId: null,
  requesterId: "requester",
  requesterName: "Requester",
  ownerId: "owner",
  ownerName: "Owner",
  agentId: "66666666-6666-4666-8666-666666666666",
  agentName: "Analyst",
  status: "accepted",
  jobId: "77777777-7777-4777-8777-777777777777",
  jobStatus: "succeeded",
  executionStatus: null,
  outcomeMessageId: null,
  version: 2,
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:01.000Z",
  canWithdraw: false,
  canReview: false,
  ...overrides
});

test("accepted request exposes private reopen only to owner and work link to current Team members", () => {
  const accepted = request();
  assert.deepEqual(teamAgentRequestCardActions(accepted, "owner"), {
    canReview: false,
    canOpenPrivateChat: true,
    canViewWork: true
  });
  assert.deepEqual(teamAgentRequestCardActions(accepted, "requester"), {
    canReview: false,
    canOpenPrivateChat: false,
    canViewWork: true
  });
});

test("native accepted request shows truthful execution state and keeps private chat owner-only", () => {
  const accepted = request({
    jobId: null,
    jobStatus: null,
    executionStatus: "running"
  });
  assert.deepEqual(teamAgentRequestCardActions(accepted, "owner"), {
    canReview: false,
    canOpenPrivateChat: true,
    canViewWork: false
  });
  assert.deepEqual(teamAgentRequestCardActions(accepted, "requester"), {
    canReview: false,
    canOpenPrivateChat: false,
    canViewWork: false
  });
  assert.equal(teamAgentRequestStatusLabel(accepted), "Accepted · working");
  assert.equal(
    teamAgentRequestStatusLabel({ ...accepted, executionStatus: "succeeded" }),
    "Completed"
  );
  assert.equal(
    teamAgentRequestStatusLabel({ ...accepted, executionStatus: "offline" }),
    "Accepted · runner offline"
  );
  assert.equal(
    teamAgentRequestStatusLabel({ ...accepted, executionStatus: "unknown" }),
    "Accepted · status unavailable"
  );
});

test("pending review requires server-granted review permission and never links a nonexistent Job", () => {
  const pending = request({
    status: "awaiting_owner",
    jobId: null,
    jobStatus: null,
    canReview: true
  });
  assert.deepEqual(teamAgentRequestCardActions(pending, "owner"), {
    canReview: true,
    canOpenPrivateChat: false,
    canViewWork: false
  });
  assert.equal(
    teamAgentRequestCardActions({ ...pending, canReview: false }, "owner")
      .canReview,
    false
  );
});

test("acceptance waits for the owner's saved goal and bound native conversation", () => {
  const pending = request({
    status: "awaiting_owner",
    jobId: null,
    jobStatus: null,
    executionStatus: null
  });
  const review = { executionId: null, privateGoal: "Implement the request" };
  assert.equal(
    teamAgentRequestCanAccept({
      request: pending,
      review,
      goal: review.privateGoal,
      executionId: null
    }),
    false
  );
  const boundReview = {
    executionId: "native-private-conversation",
    privateGoal: review.privateGoal
  };
  assert.equal(
    teamAgentRequestCanAccept({
      request: pending,
      review: boundReview,
      goal: boundReview.privateGoal,
      executionId: boundReview.executionId
    }),
    true
  );
  assert.equal(
    teamAgentRequestCanAccept({
      request: pending,
      review: boundReview,
      goal: "An unsaved change",
      executionId: boundReview.executionId
    }),
    false
  );
  assert.equal(
    teamAgentRequestCanAccept({
      request: { ...pending, status: "accepted" },
      review: boundReview,
      goal: boundReview.privateGoal,
      executionId: boundReview.executionId
    }),
    false
  );
});

test("native outcome sharing becomes available only after terminal execution", () => {
  for (const executionStatus of [
    "succeeded",
    "failed",
    "canceled",
    "interrupted"
  ] as const) {
    assert.equal(
      teamAgentRequestHasTerminalOutcome(
        request({
          status: "accepted",
          jobId: null,
          jobStatus: null,
          executionStatus
        })
      ),
      true
    );
  }
  for (const executionStatus of [
    "queued",
    "running",
    "waiting",
    "offline",
    "unknown"
  ] as const) {
    assert.equal(
      teamAgentRequestHasTerminalOutcome(
        request({
          status: "accepted",
          jobId: null,
          jobStatus: null,
          executionStatus
        })
      ),
      false
    );
  }
  assert.equal(
    teamAgentRequestHasTerminalOutcome(
      request({ status: "awaiting_owner", executionStatus: "succeeded" })
    ),
    false
  );
});

test("review navigation preserves project and draft while reopening the same native conversation", () => {
  const requestValue = request({
    status: "awaiting_owner",
    jobId: null,
    jobStatus: null,
    executionStatus: null
  });
  const review = {
    version: 5,
    executionId: "native-private-conversation"
  };
  const href = teamAgentRequestReviewHref({
    request: requestValue,
    review,
    projectId: "local-project",
    draft: "Forwarded answer"
  });
  const params = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  assert.equal(params.get("agent"), requestValue.agentId);
  assert.equal(params.get("project"), "local-project");
  assert.equal(params.get("teamRequest"), requestValue.id);
  assert.equal(params.get("teamRequestTeam"), requestValue.teamId);
  assert.equal(params.get("teamRequestVersion"), String(requestValue.version));
  assert.equal(params.get("teamReviewVersion"), "5");
  assert.equal(params.get("execution"), review.executionId);
  assert.equal(params.get("draft"), "Forwarded answer");
  assert.equal(params.has("provider"), false);
  assert.equal(params.has("job"), false);

  const firstReviewHref = teamAgentRequestReviewHref({
    request: requestValue,
    review: { version: 2, executionId: null },
    projectId: "local-project"
  });
  const firstReviewParams = new URLSearchParams(
    firstReviewHref.slice(firstReviewHref.indexOf("?") + 1)
  );
  assert.equal(firstReviewParams.has("execution"), false);
  assert.equal(
    teamAgentRequestReviewHref({
      request: requestValue,
      review,
      projectId: "local-project",
      draft: "x".repeat(3_000)
    }).length < 3_500,
    true
  );
});
