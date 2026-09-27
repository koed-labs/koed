import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node's native test runner needs the source extension.
import { loadDesktopCollaboration } from "./desktop-collaboration.ts";

const snapshot = {
  connection: {
    state: "live",
    backendId: "up_team_example",
    connectedAt: "2026-09-25T12:00:00.000Z",
    retryAt: null,
    reconnectAttempt: 0,
    protocolVersion: 1,
    apiToken: "must-not-cross"
  },
  teams: [
    {
      id: "team-1",
      name: "Authorized Team",
      role: "admin",
      unreadCount: 2,
      people: [
        { id: "person-1", displayName: "Colleague", email: "private@test" }
      ],
      workspaces: [
        { id: "workspace-1", name: "Workspace", channels: ["private"] }
      ],
      apiToken: "must-not-cross"
    }
  ],
  apiToken: "must-not-cross"
};

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

test("loads live backend Team navigation and only returns safe projected fields", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return response(snapshot);
  };

  assert.deepEqual(await loadDesktopCollaboration(fetcher), {
    mode: "desktop",
    snapshot: {
      connection: {
        state: "live",
        backendId: "up_team_example",
        connectedAt: "2026-09-25T12:00:00.000Z",
        retryAt: null,
        reconnectAttempt: 0,
        protocolVersion: 1
      },
      teams: [
        {
          id: "team-1",
          name: "Authorized Team",
          role: "admin",
          unreadCount: 2,
          people: [{ id: "person-1", displayName: "Colleague" }],
          workspaces: [{ id: "workspace-1", name: "Workspace" }]
        }
      ]
    }
  });
  assert.equal(calls[0]?.url, "/studio-api/collaboration/snapshot");
  assert.equal(calls[0]?.init?.cache, "no-store");
});

test("treats a missing Desktop callback as preview mode", async () => {
  const fetcher: typeof fetch = async () =>
    response({ error: "not_found" }, 404);
  assert.deepEqual(await loadDesktopCollaboration(fetcher), {
    mode: "preview"
  });
});

test("fails closed for unavailable or malformed responses and purges revoked Teams", async () => {
  const unavailable: typeof fetch = async () =>
    response({ error: "unavailable" }, 503);
  const invalid: typeof fetch = async () =>
    response({
      ...snapshot,
      connection: { ...snapshot.connection, state: "access_revoked" }
    });
  const malformed: typeof fetch = async () =>
    new Response("<html>not json</html>", { status: 200 });

  assert.deepEqual(await loadDesktopCollaboration(unavailable), {
    mode: "unavailable"
  });
  assert.deepEqual(await loadDesktopCollaboration(invalid), {
    mode: "desktop",
    snapshot: {
      connection: {
        state: "access_revoked",
        backendId: "up_team_example",
        connectedAt: "2026-09-25T12:00:00.000Z",
        retryAt: null,
        reconnectAttempt: 0,
        protocolVersion: 1
      },
      teams: []
    }
  });
  assert.deepEqual(await loadDesktopCollaboration(malformed), {
    mode: "unavailable"
  });
});

test("a backend switch replaces the previous authorized Team navigation", async () => {
  const switchedSnapshot = {
    connection: {
      ...snapshot.connection,
      backendId: "up_team_new_backend"
    },
    teams: [
      {
        ...snapshot.teams[0],
        id: "team-2",
        name: "New Backend Team"
      }
    ]
  };
  const fetcher: typeof fetch = async () => response(switchedSnapshot);

  assert.deepEqual(await loadDesktopCollaboration(fetcher), {
    mode: "desktop",
    snapshot: {
      connection: {
        state: "live",
        backendId: "up_team_new_backend",
        connectedAt: "2026-09-25T12:00:00.000Z",
        retryAt: null,
        reconnectAttempt: 0,
        protocolVersion: 1
      },
      teams: [
        {
          id: "team-2",
          name: "New Backend Team",
          role: "admin",
          unreadCount: 2,
          people: [{ id: "person-1", displayName: "Colleague" }],
          workspaces: [{ id: "workspace-1", name: "Workspace" }]
        }
      ]
    }
  });
});

test("rejects unsafe Team/person/workspace payload shapes", async () => {
  const payload = {
    ...snapshot,
    teams: [...snapshot.teams, { ...snapshot.teams[0], people: [{ id: "x" }] }]
  };
  const fetcher: typeof fetch = async () => response(payload);
  assert.deepEqual(await loadDesktopCollaboration(fetcher), {
    mode: "unavailable"
  });
});
