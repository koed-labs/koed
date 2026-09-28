import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native TypeScript runner requires the source extension.
import { HostedTeamCollaborationClient } from "./hosted-team-collaboration.ts";

const teamId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-09-28T12:00:00.000Z";
const rawThread = {
  id: threadId,
  logicalId: "44444444-4444-4444-8444-444444444444",
  scope: "team",
  kind: "team_channel",
  personalOwnerUserId: null,
  teamId,
  teamWorkspaceId: null,
  teamProjectId: null,
  sharedLogicalMemoryId: null,
  shareGrantId: null,
  systemKey: "team.general",
  name: "general",
  topic: null,
  createdByUserId: null,
  version: 1,
  lifecycle: "active",
  latestSequence: 1,
  lastReadMessageId: null,
  lastReadSequence: 0,
  unreadCount: 1,
  participants: [],
  createdAt: timestamp,
  updatedAt: timestamp,
  lastActivityAt: timestamp,
  archivedAt: null
};
const rawMessage = {
  id: "55555555-5555-4555-8555-555555555555",
  threadId,
  threadSequence: 1,
  audienceVersion: 1,
  scope: "team",
  personalOwnerUserId: null,
  teamId,
  teamWorkspaceId: null,
  senderKind: "user",
  senderPrincipalId: memberId,
  senderUserId: memberId,
  senderDisplayName: "Member One",
  recipientStatus: "sent",
  bodyText: "Hello **team**",
  metadata: {},
  provenance: { kind: "user", id: memberId },
  createdAt: timestamp,
  updatedAt: timestamp
};

test("maps authorized Team REST records into renderer channel and history shapes", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const client = new HostedTeamCollaborationClient(async (input, init = {}) => {
    requests.push({ url: String(input), init });
    if (String(input).includes("/channels")) return new Response(JSON.stringify({ threads: [rawThread] }));
    return new Response(JSON.stringify({ messages: [rawMessage], hasMore: true, nextBeforeSequence: 1 }));
  });
  const channels = await client.listChannels(teamId);
  assert.equal(channels[0]?.kind, "team_channel");
  assert.equal(channels[0]?.name, "general");
  const page = await client.loadMessages(teamId, threadId);
  assert.equal(page.items[0]?.body, "Hello **team**");
  assert.equal(page.items[0]?.sequence, 1);
  assert.equal(page.hasOlder, true);
  assert.equal(requests.every(({ init }) => init.credentials === "include"), true);
  assert.equal(requests[1]?.url.includes("limit=50"), true);
});

test("uses the API bodyText shape and preserves the idempotency key for send", async () => {
  let sentInit: RequestInit | undefined;
  const client = new HostedTeamCollaborationClient(async (_input, init = {}) => {
    sentInit = init;
    return new Response(JSON.stringify({ message: rawMessage }), { status: 201 });
  });
  const message = await client.sendMessage(teamId, threadId, "Hello **team**", "66666666-6666-4666-8666-666666666666");
  assert.equal(message.body, "Hello **team**");
  assert.equal(new Headers(sentInit?.headers).get("Idempotency-Key"), "66666666-6666-4666-8666-666666666666");
  assert.deepEqual(JSON.parse(String(sentInit?.body)), { bodyText: "Hello **team**" });
});

test("rejects cross-Team REST records", async () => {
  const client = new HostedTeamCollaborationClient(async () => new Response(JSON.stringify({ threads: [{ ...rawThread, teamId: "77777777-7777-4777-8777-777777777777" }] })));
  await assert.rejects(client.listChannels(teamId), /invalid Team channels/);
});
