import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  COLLABORATION_CONTRACT_VERSION,
  COLLABORATION_DEFAULT_LIMITS,
  collaborationSnapshotSchema
} from "@koed/shared/collaboration";
import { startStudioServer } from "./index.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const timestamp = "2026-09-28T12:00:00.000Z";
const snapshot = () =>
  collaborationSnapshotSchema.parse({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    snapshotRevision: "revision-gateway-test-0001",
    generatedAt: timestamp,
    connection: {
      state: "live",
      backendId: "up_team_gateway",
      connectedAt: timestamp,
      retryAt: null,
      reconnectAttempt: 0,
      protocolVersion: COLLABORATION_CONTRACT_VERSION
    },
    limits: COLLABORATION_DEFAULT_LIMITS,
    navigation: {
      personalOwner: {
        id: ownerId,
        displayName: "Owner",
        presence: "available",
        membershipState: "enabled"
      },
      teamPrincipal: null,
      personal: { memory: [], channels: [] },
      teams: []
    },
    selection: { kind: "personal_memory" },
    view: { kind: "personal_memory", entries: [] }
  });

const services = [];
after(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const start = async (options = {}) => {
  const service = await startStudioServer({ port: 0, staticDir: "/missing", ...options });
  services.push(service);
  return service;
};

const postJson = (url, body, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });

describe("Studio collaboration gateway", () => {
  it("requires a same-origin CSRF token and rejects malformed renderer commands", async () => {
    const service = await start({
      loadStudioCollaborationSnapshot: snapshot,
      runStudioCollaborationCommand: async () => null
    });
    const sessionResponse = await fetch(
      `${service.url}/studio-api/collaboration/studio-session`,
      { headers: { origin: service.url } }
    );
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.equal(session.snapshot.connection.backendId, "up_team_gateway");
    assert.equal(typeof session.csrfToken, "string");

    const endpoint = `${service.url}/studio-api/collaboration/command`;
    assert.equal((await postJson(endpoint, {})).status, 403);
    assert.equal(
      (
        await postJson(endpoint, {}, {
          origin: "http://localhost:" + new URL(service.url).port,
          "x-studio-csrf": session.csrfToken
        })
      ).status,
      403
    );
    const malformed = await postJson(
      endpoint,
      { contractVersion: COLLABORATION_CONTRACT_VERSION, command: "bad" },
      { origin: service.url, "x-studio-csrf": session.csrfToken }
    );
    assert.equal(malformed.status, 400);
  });

  it("validates command results and rejects replayed request IDs", async () => {
    const calls = [];
    const service = await start({
      loadStudioCollaborationSnapshot: snapshot,
      runStudioCollaborationCommand: async (command) => {
        calls.push(command);
        return {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: { snapshot: snapshot() }
        };
      }
    });
    const session = await (
      await fetch(`${service.url}/studio-api/collaboration/studio-session`, {
        headers: { origin: service.url }
      })
    ).json();
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: "22222222-2222-4222-8222-222222222222",
      command: "collaboration.load",
      input: {}
    };
    const headers = {
      origin: service.url,
      "x-studio-csrf": session.csrfToken
    };
    const first = await postJson(
      `${service.url}/studio-api/collaboration/command`,
      command,
      headers
    );
    assert.equal(first.status, 200);
    assert.equal((await first.json()).requestId, command.requestId);
    const replay = await postJson(
      `${service.url}/studio-api/collaboration/command`,
      command,
      headers
    );
    assert.equal(replay.status, 409);
    assert.equal(calls.length, 1);
  });

  it("reexecutes only identical Team create commands so backend idempotency can reconcile uncertainty", async () => {
    const calls = [];
    const teamId = "33333333-3333-4333-8333-333333333333";
    const service = await start({
      loadStudioCollaborationSnapshot: snapshot,
      runStudioCollaborationCommand: async (command) => {
        calls.push(command);
        return {
          contractVersion: COLLABORATION_CONTRACT_VERSION,
          requestId: command.requestId,
          command: command.command,
          ok: true,
          data: { thread: {
            id: "44444444-4444-4444-8444-444444444444",
            logicalId: "55555555-5555-4555-8555-555555555555",
            scope: "team", teamId, kind: "team_channel", name: command.input.name,
            topic: command.input.topic, systemKey: null, version: 1, lifecycle: "active",
            canPost: true, latestSequence: 0, unreadCount: 0, lastReadMessageId: null,
            lastReadSequence: 0, createdAt: timestamp, updatedAt: timestamp,
            lastActivityAt: timestamp, archivedAt: null
          } }
        };
      }
    });
    const session = await (await fetch(`${service.url}/studio-api/collaboration/studio-session`, { headers: { origin: service.url } })).json();
    const endpoint = `${service.url}/studio-api/collaboration/command`;
    const headers = { origin: service.url, "x-studio-csrf": session.csrfToken };
    const command = {
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      requestId: "66666666-6666-4666-8666-666666666666",
      command: "collaboration.create_team_channel",
      input: { teamId, name: "planning", topic: null }
    };
    assert.equal((await postJson(endpoint, command, headers)).status, 200);
    assert.equal((await postJson(endpoint, command, headers)).status, 200);
    assert.equal(calls.length, 2);
    const changed = { ...command, input: { ...command.input, name: "different" } };
    assert.equal((await postJson(endpoint, changed, headers)).status, 409);
    assert.equal(calls.length, 2);
  });

  it("streams only valid typed broker events and releases the listener on close", async () => {
    let listener;
    let unsubscribed = false;
    const current = snapshot();
    const service = await start({
      loadStudioCollaborationSnapshot: snapshot,
      subscribeStudioCollaborationEvents: (next) => {
        listener = next;
        return () => {
          unsubscribed = true;
        };
      }
    });
    const session = await (
      await fetch(`${service.url}/studio-api/collaboration/studio-session`, {
        headers: { origin: service.url }
      })
    ).json();
    const abort = new AbortController();
    const response = await fetch(
      `${service.url}/studio-api/collaboration/events`,
      {
        headers: {
          origin: service.url,
          "x-studio-csrf": session.csrfToken
        },
        signal: abort.signal
      }
    );
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /retry: 2000/);
    listener({ type: "invalid" });
    listener({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      type: "connection",
      connection: current.connection,
      error: null
    });
    const event = await reader.read();
    assert.match(new TextDecoder().decode(event.value), /"type":"connection"/);
    await reader.cancel();
    abort.abort();
    for (let attempt = 0; attempt < 20 && !unsubscribed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(unsubscribed, true);
  });

  it("admits Origin-less browser event GETs with the session token and rejects supplied invalid origins", async () => {
    let unsubscribed = false;
    const service = await start({
      loadStudioCollaborationSnapshot: snapshot,
      subscribeStudioCollaborationEvents: () => () => {
        unsubscribed = true;
      }
    });
    const sessionResponse = await fetch(
      `${service.url}/studio-api/collaboration/studio-session`
    );
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    const abort = new AbortController();
    const eventsEndpoint = `${service.url}/studio-api/collaboration/events`;
    const response = await fetch(eventsEndpoint, {
      headers: { "x-studio-csrf": session.csrfToken },
      signal: abort.signal
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /retry: 2000/);
    await reader.cancel();
    abort.abort();
    for (let attempt = 0; attempt < 20 && !unsubscribed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(unsubscribed, true);

    const port = new URL(service.url).port;
    for (const origin of ["", "not-an-origin", `http://foreign.test:${port}`]) {
      const denied = await fetch(eventsEndpoint, {
        headers: {
          origin,
          "x-studio-csrf": session.csrfToken
        }
      });
      assert.equal(denied.status, 403);
      await denied.body?.cancel();
    }
  });

  it("gates protected Team draft operations with same-origin CSRF and strict authority fields", async () => {
    const calls = [];
    const service = await start({
      loadStudioCollaborationSnapshot: snapshot,
      loadStudioTeamDraft: async (value) => {
        calls.push(["load", value]);
        return { text: "offline draft", pendingSend: null };
      },
      saveStudioTeamDraft: async (value) => calls.push(["save", value]),
      deleteStudioTeamDraft: async (value) => calls.push(["delete", value]),
      deleteStudioTeamDraftsForTeam: async (value) => calls.push(["deleteTeam", value])
    });
    const session = await (
      await fetch(`${service.url}/studio-api/collaboration/studio-session`, {
        headers: { origin: service.url }
      })
    ).json();
    const endpoint = `${service.url}/studio-api/collaboration/team-draft`;
    const request = {
      action: "load",
      authority: {
        backendId: "up_team_gateway",
        principalUserId: ownerId,
        teamId: "22222222-2222-4222-8222-222222222222",
        threadId: "33333333-3333-4333-8333-333333333333"
      }
    };
    assert.equal((await postJson(endpoint, request)).status, 403);
    const malformed = await postJson(
      endpoint,
      { ...request, authority: { ...request.authority, extra: "path" } },
      { origin: service.url, "x-studio-csrf": session.csrfToken }
    );
    assert.equal(malformed.status, 400);
    const loaded = await postJson(endpoint, request, {
      origin: service.url,
      "x-studio-csrf": session.csrfToken
    });
    assert.equal(loaded.status, 200);
    assert.deepEqual(await loaded.json(), {
      draft: { text: "offline draft", pendingSend: null }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "load");
  });
});
