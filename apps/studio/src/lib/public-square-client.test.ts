import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native TypeScript runner needs the source extension.
import { PublicSquareClient, PublicSquareRequestError } from "./public-square-client.ts";

const publication = {
  id: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  agentName: "Review agent",
  ownerId: "44444444-4444-4444-8444-444444444444",
  ownerName: "Ari",
  projectId: "55555555-5555-4555-8555-555555555555",
  projectName: "Koed",
  status: "offline",
  lastKnownStatus: "running",
  publishedAt: "2026-09-30T10:00:00.000Z",
  updatedAt: "2026-09-30T10:01:00.000Z",
  completedAt: null,
  lastSeenAt: "2026-09-30T10:00:00.000Z",
  ownerLeftTeam: false,
  sharedBrief: null,
  version: 1,
  canEditBrief: true,
  canRemoveRetainedBrief: false
};

test("hosted list uses the strict sanitized page envelope and pagination query", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new PublicSquareClient("hosted", async (input, init) => {
    calls.push({ path: String(input), init });
    return Response.json({ page: { teamId: "66666666-6666-4666-8666-666666666666", items: [publication], nextCursor: "next", serverTime: "2026-09-30T10:02:00.000Z" } });
  });
  const page = await client.list("66666666-6666-4666-8666-666666666666", { limit: 25, cursor: "cursor-a" });
  assert.equal(page.items[0]?.status, "offline");
  assert.equal(calls[0]?.path, "/v1/collaboration/teams/66666666-6666-4666-8666-666666666666/public-square?limit=25&cursor=cursor-a");
  assert.equal(calls[0]?.init?.credentials, "include");
});

test("strict page parsing rejects unapproved Job or source fields", async () => {
  const client = new PublicSquareClient("hosted", async () => Response.json({
    page: {
      teamId: "66666666-6666-4666-8666-666666666666",
      items: [{ ...publication, privateGoal: "must not be accepted", rawOutput: "private" }],
      nextCursor: null,
      serverTime: "2026-09-30T10:02:00.000Z"
    }
  }));
  await assert.rejects(client.list("66666666-6666-4666-8666-666666666666"), (failure: unknown) => failure instanceof PublicSquareRequestError && failure.status === 502);
});

test("Desktop connection writes use the Studio gateway and CSRF token with compare-and-set version", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new PublicSquareClient("studio", async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === "/studio-api/projects/session") return Response.json({ csrfToken: "csrf-a" });
    return Response.json({ connection: {
      teamId: "66666666-6666-4666-8666-666666666666",
      teamProjectId: "55555555-5555-4555-8555-555555555555",
      localProjectId: "local-project-a",
      connectedAt: "2026-09-30T10:02:00.000Z",
      version: 4
    } });
  });
  const connection = await client.setConnection({
    teamId: "66666666-6666-4666-8666-666666666666",
    teamProjectId: "55555555-5555-4555-8555-555555555555",
    localProjectId: "local-project-a",
    expectedVersion: 3
  });
  assert.equal(connection.version, 4);
  assert.equal(calls[1]?.path, "/studio-api/public-square/teams/66666666-6666-4666-8666-666666666666/projects/55555555-5555-4555-8555-555555555555/connection");
  assert.equal(calls[1]?.init?.method, "PUT");
  assert.equal(new Headers(calls[1]?.init?.headers).get("x-studio-csrf"), "csrf-a");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { expectedVersion: 3, localProjectId: "local-project-a" });
});

test("authorization loss stays distinguishable for the host to clear its Team view", async () => {
  const client = new PublicSquareClient("hosted", async () => Response.json({ error: "forbidden" }, { status: 403 }));
  await assert.rejects(client.list("66666666-6666-4666-8666-666666666666"), (failure: unknown) => failure instanceof PublicSquareRequestError && failure.status === 403);
});
