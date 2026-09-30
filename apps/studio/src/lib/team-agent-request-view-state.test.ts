import assert from "node:assert/strict";
import test from "node:test";
import type { TeamAgentRequest } from "@koed/shared/team-agent-requests";
// @ts-expect-error -- Node's native test runner needs the source extension.
import { teamAgentRequestCardActions } from "./team-agent-request-view-state.ts";

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
