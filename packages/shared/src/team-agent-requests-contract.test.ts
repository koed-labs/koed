import { describe, expect, it } from "vitest";
import {
  teamAgentOfferSchema,
  teamAgentRequestInvalidationSchema,
  teamAgentRequestSchema,
  teamAgentRequestReviewSchema,
  updateTeamAgentRequestReviewInputSchema
} from "./team-agent-requests-contract.js";

const ids = {
  team: "018f47b2-3f6d-7a45-8c52-5a1f62090001",
  project: "018f47b2-3f6d-7a45-8c52-5a1f62090002",
  channel: "018f47b2-3f6d-7a45-8c52-5a1f62090003",
  request: "018f47b2-3f6d-7a45-8c52-5a1f62090004",
  requester: "018f47b2-3f6d-7a45-8c52-5a1f62090005",
  owner: "018f47b2-3f6d-7a45-8c52-5a1f62090006",
  agent: "018f47b2-3f6d-7a45-8c52-5a1f62090007",
  message: "018f47b2-3f6d-7a45-8c52-5a1f62090008",
  execution: "018f47b2-3f6d-7a45-8c52-5a1f62090009",
  job: "018f47b2-3f6d-7a45-8c52-5a1f62090010"
};

const request = {
  id: ids.request,
  teamId: ids.team,
  teamProjectId: ids.project,
  channelId: ids.channel,
  requestMessageId: ids.message,
  requesterId: ids.requester,
  requesterName: "Rae",
  ownerId: ids.owner,
  ownerName: "Morgan",
  agentId: ids.agent,
  agentName: "Planner",
  status: "accepted",
  jobId: ids.job,
  jobStatus: "queued",
  outcomeMessageId: null,
  version: 2,
  createdAt: "2026-09-30T12:00:00.000Z",
  updatedAt: "2026-09-30T12:02:00.000Z",
  canWithdraw: false,
  canReview: false
} as const;

describe("Team Agent Request contracts", () => {
  it("keeps request DTOs safe and separates accepted from actual Job state", () => {
    expect(teamAgentRequestSchema.safeParse(request).success).toBe(true);
    expect(
      teamAgentRequestSchema.safeParse({
        ...request,
        privateGoal: "private prompt"
      }).success
    ).toBe(false);
    expect(
      teamAgentRequestSchema.safeParse({ ...request, jobStatus: "pending" })
        .success
    ).toBe(false);
  });

  it("rejects owner-only Agent instructions from the Team offer DTO", () => {
    const offer = {
      teamId: ids.team,
      agentId: ids.agent,
      ownerId: ids.owner,
      ownerName: "Morgan",
      agentName: "Planner",
      description: "Helps prepare a work plan.",
      enabled: true,
      version: 1,
      canManage: false
    };
    expect(teamAgentOfferSchema.safeParse(offer).success).toBe(true);
    expect(
      teamAgentOfferSchema.safeParse({
        ...offer,
        instructions: "secret instructions"
      }).success
    ).toBe(false);
  });

  it("keeps reviewed goal and execution linkage in an owner-only contract", () => {
    expect(
      teamAgentRequestReviewSchema.safeParse({
        teamId: ids.team,
        requestId: ids.request,
        executionId: ids.execution,
        privateGoal: "Private execution goal",
        version: 3
      }).success
    ).toBe(true);
    expect(
      updateTeamAgentRequestReviewInputSchema.safeParse({
        expectedVersion: 2,
        privateGoal: "Private execution goal",
        executionId: ids.execution,
        requesterId: ids.requester
      }).success
    ).toBe(false);
  });

  it("accepts only content-free Team request invalidations", () => {
    const event = {
      type: "team_agent_request_invalidated",
      teamId: ids.team,
      requestId: ids.request,
      channelId: ids.channel,
      ownerId: ids.owner,
      kind: "request"
    };
    expect(teamAgentRequestInvalidationSchema.safeParse(event).success).toBe(
      true
    );
    expect(
      teamAgentRequestInvalidationSchema.safeParse({
        ...event,
        privateGoal: "private"
      }).success
    ).toBe(false);
    expect(
      teamAgentRequestInvalidationSchema.safeParse({
        ...event,
        requestId: null
      }).success
    ).toBe(false);
  });
});
