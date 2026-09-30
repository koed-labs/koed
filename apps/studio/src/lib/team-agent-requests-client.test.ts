import assert from "node:assert/strict";
import test from "node:test";
import {
  TeamAgentRequestError,
  TeamAgentRequestsClient
  // @ts-expect-error -- Node's native TypeScript runner needs the source extension.
} from "./team-agent-requests-client.ts";

const teamId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const channelId = "55555555-5555-4555-8555-555555555555";
const time = "2026-09-30T10:00:00.000Z";

const request = {
  id: requestId,
  teamId,
  teamProjectId: projectId,
  channelId,
  requestMessageId: "66666666-6666-4666-8666-666666666666",
  requesterId: "77777777-7777-4777-8777-777777777777",
  requesterName: "Mina",
  ownerId: "88888888-8888-4888-8888-888888888888",
  ownerName: "Ari",
  agentId,
  agentName: "Ari · Research Agent",
  status: "awaiting_owner",
  jobId: null,
  jobStatus: null,
  outcomeMessageId: null,
  version: 0,
  createdAt: time,
  updatedAt: time,
  canWithdraw: true,
  canReview: false
} as const;

test("hosted offers and requests use strict sanitized Team DTOs", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new TeamAgentRequestsClient("hosted", async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path.endsWith("/agent-offers"))
      return Response.json({
        teamId,
        offers: [
          {
            teamId,
            agentId,
            ownerId: request.ownerId,
            ownerName: "Ari",
            agentName: request.agentName,
            description: "Research",
            enabled: true,
            version: 2,
            canManage: false
          }
        ],
        serverTime: time
      });
    return Response.json({ request });
  });
  const offers = await client.listOffers(teamId);
  assert.equal(offers[0]?.agentName, request.agentName);
  assert.equal(
    calls[0]?.path,
    `/v1/collaboration/teams/${teamId}/agent-offers`
  );
  assert.equal(calls[0]?.init?.credentials, "include");
  const created = await client.createRequest(teamId, {
    idempotencyKey: "99999999-9999-4999-8999-999999999999",
    teamProjectId: projectId,
    channelId,
    agentId,
    requestText: "Review the migration plan"
  });
  assert.equal(created.id, requestId);
  assert.equal(
    calls[1]?.path,
    `/v1/collaboration/teams/${teamId}/agent-requests`
  );
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    idempotencyKey: "99999999-9999-4999-8999-999999999999",
    teamProjectId: projectId,
    channelId,
    agentId,
    requestText: "Review the migration plan"
  });
});

test("strict request parsing rejects private goal or execution data in Team DTOs", async () => {
  const client = new TeamAgentRequestsClient("hosted", async () =>
    Response.json({
      request: { ...request, privateGoal: "private", executionId: projectId }
    })
  );
  await assert.rejects(
    client.createRequest(teamId, {
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      teamProjectId: projectId,
      channelId,
      agentId,
      requestText: "Review this"
    }),
    (failure: unknown) =>
      failure instanceof TeamAgentRequestError && failure.status === 502
  );
});

test("Desktop private review writes use the CSRF gateway and persist the owner execution", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new TeamAgentRequestsClient("studio", async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === "/studio-api/projects/session")
      return Response.json({ csrfToken: "csrf-a" });
    return Response.json({
      review: {
        teamId,
        requestId,
        executionId: projectId,
        privateGoal: "Owner-reviewed goal",
        version: 3
      }
    });
  });
  const review = await client.updateReview({
    teamId,
    requestId,
    expectedVersion: 2,
    executionId: projectId,
    privateGoal: "Owner-reviewed goal"
  });
  assert.equal(review.version, 3);
  assert.equal(
    calls[1]?.path,
    `/studio-api/collaboration/teams/${teamId}/agent-requests/${requestId}/review`
  );
  assert.equal(calls[1]?.init?.method, "PUT");
  assert.equal(
    new Headers(calls[1]?.init?.headers).get("x-studio-csrf"),
    "csrf-a"
  );
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    expectedVersion: 2,
    executionId: projectId,
    privateGoal: "Owner-reviewed goal"
  });
});

test("request inbox pagination is scoped and stale writes remain visible as conflicts", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new TeamAgentRequestsClient("hosted", async (input, init) => {
    calls.push({ path: String(input), init });
    return Response.json({
      teamId,
      requests: [request],
      nextCursor: "next-page",
      serverTime: time
    });
  });
  const page = await client.listInbox(teamId, { limit: 25, cursor: "older" });
  assert.equal(page.requests[0]?.id, requestId);
  assert.equal(
    calls[0]?.path,
    `/v1/collaboration/teams/${teamId}/agent-requests/inbox?limit=25&cursor=older`
  );

  const conflict = new TeamAgentRequestsClient("hosted", async () =>
    Response.json({ error: "stale_version" }, { status: 409 })
  );
  await assert.rejects(
    conflict.decideRequest({
      teamId,
      requestId,
      expectedVersion: 2,
      decision: "accept"
    }),
    (failure: unknown) =>
      failure instanceof TeamAgentRequestError && failure.status === 409
  );
});
