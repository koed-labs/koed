import assert from "node:assert/strict";
import test from "node:test";
import { COLLABORATION_CONTRACT_VERSION, COLLABORATION_DEFAULT_LIMITS, collaborationRendererEventSchema, collaborationSnapshotSchema, type CollaborationRendererEvent } from "@koed/shared/collaboration";
// @ts-expect-error -- Node's native TypeScript runner requires the source extension.
import { HostedTeamCollaborationClient } from "./hosted-team-collaboration.ts";
// @ts-expect-error -- Node's native TypeScript runner requires the source extension.
import { canApplySubscriptionSnapshot, StudioCollaborationClient } from "./studio-collaboration-client.ts";

const teamId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const memberId = "33333333-3333-4333-8333-333333333333";
const otherMemberId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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

test("maps Team people and direct-message REST records and preserves historical membership state", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const dm = {
    ...rawThread,
    kind: "dm",
    name: null,
    topic: null,
    participants: [
      { userId: memberId, displayName: "Member One", membershipState: "enabled" },
      { userId: otherMemberId, displayName: null, membershipState: "enabled" }
    ]
  };
  const historicalDm = { ...dm, participants: [dm.participants[0], { ...dm.participants[1], membershipState: "disabled" }] };
  const client = new HostedTeamCollaborationClient(async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/participants")) return new Response(JSON.stringify({ participants: [
      { userId: memberId, displayName: "Member One" },
      { userId: otherMemberId, displayName: null }
    ] }));
    if (url.endsWith("/direct-messages") && init.method !== "POST") return new Response(JSON.stringify({ threads: [historicalDm] }));
    return new Response(JSON.stringify({ thread: dm }), { status: 201 });
  });
  assert.deepEqual(await client.listPeople(teamId), [
    { id: memberId, displayName: "Member One", membershipState: "enabled" },
    { id: otherMemberId, displayName: "Team member", membershipState: "enabled" }
  ]);
  const listed = await client.listDirectMessages(teamId);
  assert.equal(listed[0]?.kind, "dm");
  if (listed[0]?.kind === "dm") assert.deepEqual(listed[0].participants.map(({ id, membershipState }) => ({ id, membershipState })), [
    { id: memberId, membershipState: "enabled" },
    { id: otherMemberId, membershipState: "disabled" }
  ]);
  const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  assert.equal((await client.startDirectMessage(teamId, otherMemberId, requestId)).kind, "dm");
  assert.equal(new Headers(calls[2]?.init.headers).get("Idempotency-Key"), requestId);
  assert.deepEqual(JSON.parse(String(calls[2]?.init.body)), { participantUserId: otherMemberId });
});

test("rejects malformed and cross-Team direct-message records", async () => {
  const invalid = [
    { ...rawThread, kind: "dm", name: null, topic: null, participants: [{ userId: memberId, displayName: "Member One", membershipState: "enabled" }] },
    { ...rawThread, teamId: "77777777-7777-4777-8777-777777777777", kind: "dm", name: null, topic: null, participants: [{ userId: memberId, displayName: "Member One", membershipState: "enabled" }, { userId: otherMemberId, displayName: "Member Two", membershipState: "enabled" }] },
    { ...rawThread, kind: "dm", name: null, topic: null, participants: [{ userId: memberId, displayName: "Member One", membershipState: "enabled" }, { userId: "not-a-uuid", displayName: "Member Two", membershipState: "enabled" }] }
  ];
  for (const thread of invalid) {
    const client = new HostedTeamCollaborationClient(async () => new Response(JSON.stringify({ threads: [thread] })));
    await assert.rejects(client.listDirectMessages(teamId), /invalid Team direct messages/);
  }
});

test("starts group direct messages with the selected participant set and idempotency key", async () => {
  const group = {
    ...rawThread,
    kind: "group_dm",
    participants: [
      { userId: memberId, displayName: "Member One", membershipState: "enabled" },
      { userId: otherMemberId, displayName: "Member Two", membershipState: "enabled" },
      { userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", displayName: "Member Three", membershipState: "enabled" }
    ]
  };
  let sent: RequestInit | undefined;
  const client = new HostedTeamCollaborationClient(async (_input, init = {}) => {
    sent = init;
    return new Response(JSON.stringify({ thread: group }), { status: 201 });
  });
  const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const participantIds = [otherMemberId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"];
  assert.equal((await client.startGroupDirectMessage(teamId, participantIds, requestId)).kind, "group_dm");
  assert.equal(new Headers(sent?.headers).get("Idempotency-Key"), requestId);
  assert.deepEqual(JSON.parse(String(sent?.body)), { participantUserIds: participantIds });
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

test("binds fetch when the browser request function is stored on a client", async () => {
  const receivers: unknown[] = [];
  const fetcher = function (this: unknown) {
    receivers.push(this);
    return Promise.resolve(new Response(JSON.stringify({ error: "offline" }), { status: 503 }));
  } as typeof fetch;
  const hosted = new HostedTeamCollaborationClient(fetcher);
  const desktop = new StudioCollaborationClient(fetcher);
  await assert.rejects(hosted.listChannels(teamId));
  await assert.rejects(desktop.loadSession());
  assert.deepEqual(receivers, [globalThis, globalThis]);
});

test("Desktop subscription opens event forwarding first, applies Team deliveries, acknowledges sequentially, and unsubscribes on cleanup", async () => {
  const calls: Array<{ url: string; command?: Record<string, unknown> }> = [];
  const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const subscriptionId = "77777777-7777-4777-8777-777777777777";
  const renewedSubscriptionId = "88888888-8888-4888-8888-888888888888";
  const subscriptionVersions = new Map([[subscriptionId, 1], [renewedSubscriptionId, 1]]);
  let subscriptionAttempts = 0;
  let eventStreamRequests = 0;
  const sessionSnapshot = collaborationSnapshotSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    snapshotRevision: "revision-studio-subscribe-0001",
    generatedAt: timestamp,
    connection: { state: "live", backendId: "up_team_example", connectedAt: timestamp, retryAt: null, reconnectAttempt: 0, protocolVersion: COLLABORATION_CONTRACT_VERSION },
    limits: COLLABORATION_DEFAULT_LIMITS,
    navigation: { personalOwner: { id: memberId, displayName: "Member One", presence: "available", membershipState: "enabled" }, teamPrincipal: null, personal: { memory: [], channels: [] }, teams: [] },
    selection: { kind: "personal_memory" },
    view: { kind: "personal_memory", entries: [] }
  });
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/studio-session")) { calls.push({ url }); return new Response(JSON.stringify({ snapshot: sessionSnapshot, csrfToken: "csrf-token" })); }
    if (url.endsWith("/events")) {
      calls.push({ url });
      eventStreamRequests += 1;
      if (eventStreamRequests === 3) return new Response(JSON.stringify({ error: "subscription_replaced" }), { status: 409 });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { streamControllers.push(controller); } }), { headers: { "content-type": "text/event-stream" } });
    }
    const command = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, command });
    const requestId = command.requestId;
    if (command.command === "collaboration.subscribe") {
      subscriptionAttempts += 1;
      if (subscriptionAttempts === 1) return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 });
      const id = subscriptionAttempts === 2 ? subscriptionId : renewedSubscriptionId;
      return new Response(JSON.stringify({ contractVersion: COLLABORATION_CONTRACT_VERSION, requestId, command: command.command, ok: true, data: { subscription: { id, scope: { scope: "team", teamId }, state: "awaiting_snapshot_ack", version: subscriptionVersions.get(id), expiresAt: "2026-09-28T13:00:00.000Z" } } }));
    }
    if (command.command === "collaboration.acknowledge_delivery") {
      const input = command.input as Record<string, unknown>;
      const acknowledgedSubscriptionId = String(input.subscriptionId);
      const subscriptionVersion = (subscriptionVersions.get(acknowledgedSubscriptionId) ?? 1) + 1;
      subscriptionVersions.set(acknowledgedSubscriptionId, subscriptionVersion);
      return new Response(JSON.stringify({ contractVersion: COLLABORATION_CONTRACT_VERSION, requestId, command: command.command, ok: true, data: { subscriptionId: acknowledgedSubscriptionId, acknowledgedEventId: input.eventId, subscriptionVersion } }));
    }
    return new Response(JSON.stringify({ contractVersion: COLLABORATION_CONTRACT_VERSION, requestId, command: command.command, ok: true, data: {} }));
  };
  const client = new StudioCollaborationClient(fetcher);
  const applied: string[] = [];
  let reconnectSnapshots = 0;
  let failFirstUpdateApplication = true;
  const unsubscribe = client.subscribe(async (event) => {
    if (event.type === "update" && failFirstUpdateApplication) {
      failFirstUpdateApplication = false;
      return false;
    }
    applied.push(event.type);
  }, () => { reconnectSnapshots += 1; }, teamId);
  for (let attempt = 0; attempt < 300 && subscriptionAttempts < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(subscriptionAttempts, 2);
  assert.equal(calls[0]?.url.endsWith("/studio-session"), true);
  assert.equal(calls.findIndex((call) => call.url.endsWith("/events")) < calls.findIndex((call) => call.command?.command === "collaboration.subscribe"), true);
  const activeStream = streamControllers[0]!;
  const teamPrincipal = { id: memberId, displayName: "Member One", presence: "available", membershipState: "enabled" };
  const teamPerson = { ...teamPrincipal, teamPresence: { mode: "auto", manualStatus: "available", activityLevel: null, lastActivityAt: null, nextTransitionAt: null, preferenceVersion: 1 } };
  const teamNavigation = { id: teamId, name: "Team One", role: "member", lifecycle: "active", unreadCount: 0, people: [teamPerson], directMessages: [], channels: [], sharedProjects: [], workspaces: [], version: 1 };
  const snapshotEvent = collaborationRendererEventSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    type: "snapshot",
    subscription: { id: subscriptionId, scope: { scope: "team", teamId }, state: "awaiting_snapshot_ack", version: 1, expiresAt: "2026-09-28T13:00:00.000Z" },
    deliveryId: "delivery-studio-test-snapshot-0001",
    eventId: null,
    snapshot: { scope: "team", teamId, snapshotRevision: "revision-studio-realtime-0001", teamPrincipal, team: teamNavigation, selection: { kind: "team_people", teamId }, view: { kind: "team_people", teamId, people: [teamPerson] } }
  });
  activeStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(snapshotEvent)}\n\n`));
  for (let attempt = 0; attempt < 40 && calls.filter((call) => call.command?.command === "collaboration.acknowledge_delivery").length < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(applied, ["snapshot"]);
  const event = collaborationRendererEventSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    type: "update",
    subscriptionId,
    deliveryId: "delivery-studio-test-000000000001",
    eventId: "88888888-8888-4888-8888-888888888888",
    occurredAt: timestamp,
    family: "message_created",
    resource: { scope: "team", teamId, workspaceId: null, threadId, messageId: "99999999-9999-4999-8999-999999999999", sharedSessionId: null, shareGrantId: null },
    update: { type: "message_created", message: { id: "99999999-9999-4999-8999-999999999999", clientMessageId: null, threadId, scope: "team", teamId, sequence: 1, sender: { id: memberId, displayName: "Member One", membershipState: "enabled" }, senderKind: "user", body: "New message", createdAt: timestamp, updatedAt: timestamp, editedAt: null, deletedAt: null, delivery: "sent", recipientStatus: "sent", failure: null } }
  });
  activeStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.filter((call) => call.command?.command === "collaboration.acknowledge_delivery").length, 1);
  assert.deepEqual(applied, ["snapshot"]);
  activeStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  for (let attempt = 0; attempt < 40 && calls.filter((call) => call.command?.command === "collaboration.acknowledge_delivery").length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(applied, ["snapshot", "update"]);
  const secondEvent = { ...event, deliveryId: "delivery-studio-test-000000000002", eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  activeStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(secondEvent)}\n\n`));
  for (let attempt = 0; attempt < 40 && calls.filter((call) => call.command?.command === "collaboration.acknowledge_delivery").length < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(applied, ["snapshot", "update", "update"]);
  const acknowledgements = calls.filter((call) => call.command?.command === "collaboration.acknowledge_delivery").map((call) => call.command?.input as Record<string, unknown>);
  assert.deepEqual(acknowledgements.map((ack) => ack.expectedSubscriptionVersion), [1, 2, 3]);
  activeStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.filter((call) => call.command?.command === "collaboration.acknowledge_delivery").length, 3);
  assert.deepEqual(applied, ["snapshot", "update", "update"]);
  activeStream.close();
  for (let attempt = 0; attempt < 40 && streamControllers.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  for (let attempt = 0; attempt < 40 && reconnectSnapshots < 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(streamControllers.length, 2);
  assert.equal(reconnectSnapshots, 1);
  const thirdEvent = { ...event, deliveryId: "delivery-studio-test-000000000003", eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  streamControllers[1]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(thirdEvent)}\n\n`));
  for (let attempt = 0; attempt < 40 && calls.filter((call) => call.command?.command === "collaboration.acknowledge_delivery").length < 4; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  const afterReconnectAcks = calls.filter((call) => call.command?.command === "collaboration.acknowledge_delivery").map((call) => call.command?.input as Record<string, unknown>);
  assert.deepEqual(afterReconnectAcks.map((ack) => ack.expectedSubscriptionVersion), [1, 2, 3, 4]);
  assert.deepEqual(applied, ["snapshot", "update", "update", "update"]);

  const requiresSnapshot = collaborationRendererEventSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    type: "control",
    subscriptionId,
    occurredAt: timestamp,
    reason: "requires_snapshot"
  });
  streamControllers[1]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(requiresSnapshot)}\n\n`));
  for (let attempt = 0; attempt < 100 && subscriptionAttempts < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(subscriptionAttempts, 3);
  assert.equal(calls.some((call) => call.command?.command === "collaboration.unsubscribe" && (call.command.input as Record<string, unknown>).subscriptionId === subscriptionId), true);
  streamControllers[1]!.close();
  for (let attempt = 0; attempt < 300 && streamControllers.length < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(eventStreamRequests >= 4, true); // Includes the broker's expected 409 before the renewed stream opens.
  const originalSnapshotEvent = snapshotEvent as Extract<CollaborationRendererEvent, { type: "snapshot" }>;
  const renewedSnapshot = collaborationRendererEventSchema.parse({
    ...originalSnapshotEvent,
    subscription: { ...originalSnapshotEvent.subscription, id: renewedSubscriptionId },
    deliveryId: "delivery-studio-test-renewed-snapshot-0001",
    snapshot: { ...originalSnapshotEvent.snapshot, snapshotRevision: "revision-studio-realtime-0002" }
  });
  streamControllers[2]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(renewedSnapshot)}\n\n`));
  for (let attempt = 0; attempt < 100 && calls.filter((call) => call.command?.command === "collaboration.acknowledge_delivery").length < 5; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  const renewedUpdate = collaborationRendererEventSchema.parse({
    ...event,
    subscriptionId: renewedSubscriptionId,
    deliveryId: "delivery-studio-test-renewed-update-0001",
    eventId: "99999999-9999-4999-8999-999999999999"
  });
  streamControllers[2]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(renewedUpdate)}\n\n`));
  for (let attempt = 0; attempt < 100 && calls.filter((call) => call.command?.command === "collaboration.acknowledge_delivery").length < 6; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  const allAcks = calls.filter((call) => call.command?.command === "collaboration.acknowledge_delivery").map((call) => call.command?.input as Record<string, unknown>);
  assert.deepEqual(allAcks.slice(-2).map((ack) => [ack.subscriptionId, ack.expectedSubscriptionVersion]), [[renewedSubscriptionId, 1], [renewedSubscriptionId, 2]]);
  assert.deepEqual(applied.slice(-3), ["control", "snapshot", "update"]);
  unsubscribe();
  for (let attempt = 0; attempt < 40 && !calls.some((call) => call.command?.command === "collaboration.unsubscribe"); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.some((call) => call.command?.command === "collaboration.unsubscribe"), true);
  streamControllers[2]?.close();
});

test("replayed older snapshots cannot roll back an acknowledged Team subscription version", () => {
  assert.equal(canApplySubscriptionSnapshot({ currentVersion: 3, snapshotVersion: 2, alreadyAcknowledged: false }), false);
  assert.equal(canApplySubscriptionSnapshot({ currentVersion: 3, snapshotVersion: 3, alreadyAcknowledged: false }), true);
  assert.equal(canApplySubscriptionSnapshot({ currentVersion: 3, snapshotVersion: 3, alreadyAcknowledged: true }), false);
});

test("access revocation releases a subscription whose create response arrives late", async () => {
  const sessionSnapshot = collaborationSnapshotSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    snapshotRevision: "revision-studio-revocation-0001",
    generatedAt: timestamp,
    connection: { state: "live", backendId: "up_team_example", connectedAt: timestamp, retryAt: null, reconnectAttempt: 0, protocolVersion: COLLABORATION_CONTRACT_VERSION },
    limits: COLLABORATION_DEFAULT_LIMITS,
    navigation: { personalOwner: { id: memberId, displayName: "Member One", presence: "available", membershipState: "enabled" }, teamPrincipal: null, personal: { memory: [], channels: [] }, teams: [] },
    selection: { kind: "personal_memory" },
    view: { kind: "personal_memory", entries: [] }
  });
  const subscriptionId = "99999999-9999-4999-8999-999999999999";
  const streamControllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  let resolveSubscribe: ((response: Response) => void) | null = null;
  let resolveSubscribeStarted: (() => void) | null = null;
  let resolveRevocationSeen: (() => void) | null = null;
  const subscribeStarted = new Promise<void>((resolve) => { resolveSubscribeStarted = resolve; });
  const revocationSeen = new Promise<void>((resolve) => { resolveRevocationSeen = resolve; });
  const subscribeResponse = new Promise<Response>((resolve) => { resolveSubscribe = resolve; });
  const commands: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/studio-session")) return new Response(JSON.stringify({ snapshot: sessionSnapshot, csrfToken: "csrf-token" }));
    if (url.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({ start(controller) { streamControllers.push(controller); } }), { headers: { "content-type": "text/event-stream" } });
    const command = JSON.parse(String(init.body)) as Record<string, unknown>;
    commands.push(command);
    const requestId = command.requestId;
    if (command.command === "collaboration.subscribe") {
      resolveSubscribeStarted?.();
      return await subscribeResponse;
    }
    return new Response(JSON.stringify({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId,
      command: command.command,
      ok: true,
      data: command.command === "collaboration.unsubscribe" ? {} : {}
    }));
  };
  const client = new StudioCollaborationClient(fetcher);
  const unsubscribe = client.subscribe((event) => {
    if (event.type === "connection" && event.connection.state === "access_revoked") resolveRevocationSeen?.();
  }, undefined, teamId);
  await subscribeStarted;
  const revokedConnection: CollaborationRendererEvent = {
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    type: "connection",
    connection: { ...sessionSnapshot.connection, state: "access_revoked" },
    error: null
  };
  streamControllers[0]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(revokedConnection)}\n\n`));
  await revocationSeen;
  resolveSubscribe!(new Response(JSON.stringify({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    requestId: commands.find((item) => item.command === "collaboration.subscribe")?.requestId,
    command: "collaboration.subscribe",
    ok: true,
    data: { subscription: { id: subscriptionId, scope: { scope: "team", teamId }, state: "awaiting_snapshot_ack", version: 1, expiresAt: "2026-09-28T13:00:00.000Z" } }
  })));
  for (let attempt = 0; attempt < 100 && !commands.some((item) => item.command === "collaboration.unsubscribe"); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(commands.filter((item) => item.command === "collaboration.subscribe").length, 1);
  assert.equal(commands.some((item) => item.command === "collaboration.unsubscribe" && (item.input as Record<string, unknown>).subscriptionId === subscriptionId), true);
  unsubscribe();
  streamControllers[0]?.close();
});
