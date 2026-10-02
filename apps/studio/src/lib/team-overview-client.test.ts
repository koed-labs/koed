import assert from "node:assert/strict";
import test from "node:test";
import {
  TeamOverviewClient
  // @ts-expect-error -- Node's native TypeScript runner needs the source extension.
} from "./team-overview-client.ts";

const teamId = "00000000-0000-4000-8000-000000000001";
const item = {
  sourceEventId: "message_attention:thread:root",
  source: "message_attention" as const,
  sourceId: "root",
  sourceRevision: "4",
  teamId,
  teamName: "Studio",
  kind: "message" as const,
  priority: "blocker" as const,
  state: "blocked" as const,
  title: "Review the channel thread",
  summary: "A reply needs your attention.",
  updatedAt: "2026-10-01T10:00:00.000Z",
  unreadCount: 2,
  destination: {
    kind: "thread" as const,
    threadId: "00000000-0000-4000-8000-000000000002",
    rootMessageId: "00000000-0000-4000-8000-000000000003"
  }
};
const snapshot = {
  schemaVersion: "koed.team-overview/v1" as const,
  access: { accountScope: "user:one", backendId: "backend-one" },
  generatedAt: "2026-10-01T10:00:00.000Z",
  teams: [{ teamId, name: "Studio", badgeCount: 1 }],
  coverage: [],
  currentJobOutcomes: [],
  attention: [item],
  catchUp: [],
  cleared: [],
  nextCursor: "cursor 2",
  badgeCount: 1
};

test("overview GET uses the shell-specific all-Teams route and strict no-store parsing", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return Response.json(snapshot);
  }) as typeof fetch;
  const hosted = new TeamOverviewClient("hosted", fetcher);
  await hosted.getOverview({ cursor: "cursor 2", limit: 20 });
  assert.equal(
    calls[0]?.input,
    "/v1/collaboration/teams/overview?cursor=cursor+2&limit=20"
  );
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(calls[0]?.init?.cache, "no-store");

  calls.length = 0;
  const studio = new TeamOverviewClient("studio", fetcher);
  await studio.getOverview();
  assert.equal(calls[0]?.input, "/studio-api/collaboration/teams/overview");
  assert.equal(calls[0]?.init?.credentials, "same-origin");
});

test("Studio clear targets the exact Team/source event and carries the CSRF token", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ input: path, init });
    if (path === "/studio-api/github/session")
      return Response.json({ csrfToken: "csrf-value" });
    if (init?.method === "POST")
      return Response.json({
        sourceEventId: item.sourceEventId,
        sourceRevision: item.sourceRevision,
        cleared: true,
        seen: false
      });
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch;
  const client = new TeamOverviewClient("studio", fetcher);
  await client.mutate(item, "clear");
  assert.deepEqual(
    calls.map((call) => call.input),
    [
      "/studio-api/github/session",
      `/studio-api/collaboration/teams/${teamId}/overview/${encodeURIComponent(item.sourceEventId)}/clear`
    ]
  );
  assert.equal(calls[1]?.init?.method, "POST");
  assert.equal(
    new Headers(calls[1]?.init?.headers).get("x-studio-csrf"),
    "csrf-value"
  );
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    sourceRevision: item.sourceRevision
  });
});

test("Hosted seen does not request Studio CSRF and rejects a mismatched mutation result", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    return Response.json({
      sourceEventId: "another-event",
      sourceRevision: item.sourceRevision,
      cleared: false,
      seen: true
    });
  }) as typeof fetch;
  const client = new TeamOverviewClient("hosted", fetcher);
  await assert.rejects(() => client.mutate(item, "seen"), /invalid update/i);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.input,
    `/v1/collaboration/teams/${teamId}/overview/${encodeURIComponent(item.sourceEventId)}/seen`
  );
  assert.equal(calls[0]?.init?.credentials, "include");
});
