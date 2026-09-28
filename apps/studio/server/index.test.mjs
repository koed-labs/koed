import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import {
  readHomeSnapshot,
  resolveLocalConversationCapture,
  startStudioServer
} from "./index.mjs";

const uuid = "11111111-1111-4111-8111-111111111111";
const execution = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: "project",
  provider: "codex",
  state: "running",
  updatedAt: "2026-09-21T10:00:00.000Z",
  sessionId: uuid
};

const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });

const homeFetch =
  ({ runtime = { items: [] }, executions = [execution], threads = [] } = {}) =>
  async (url, init) => {
    const pathname = new URL(url).pathname;
    assert.equal(init.headers.authorization, "Bearer test-secret");
    if (pathname.endsWith("/access"))
      return response({ user: { id: "owner" } });
    if (pathname.endsWith("/managed-conversations"))
      return response({ executions });
    if (pathname.endsWith("/runtime")) return response(runtime);
    return response({ projects: [{ name: "Personal", threads }] });
  };

const get = (url, headers = {}, method = "GET") =>
  new Promise((resolve, reject) => {
    const req = request(url, { headers, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8")
        })
      );
    });
    req.on("error", reject);
    req.end();
  });

const sendJson = (url, { headers = {}, method = "POST", body } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      url,
      {
        headers: {
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload)
              }),
          ...headers
        },
        method
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", reject);
    req.end(payload);
  });

describe("Studio Home gateway", () => {
  let started;
  let staticDir;

  afterEach(async () => {
    await started?.close?.();
    if (staticDir) await rm(staticDir, { recursive: true, force: true });
    started = undefined;
    staticDir = undefined;
  });

  it("returns an honest empty Personal snapshot without leaking the token", async () => {
    const snapshot = await readHomeSnapshot({
      fetchImpl: homeFetch({ executions: [], threads: [] }),
      token: "test-secret"
    });
    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.scopeKey, "http://127.0.0.1:43300|owner");
    assert.deepEqual(snapshot.executions, []);
    assert.deepEqual(snapshot.requests, []);
    assert.deepEqual(snapshot.recents, []);
    assert.equal(JSON.stringify(snapshot).includes("test-secret"), false);
  });

  it("maps unauthorized access distinctly", async () => {
    const snapshot = await readHomeSnapshot({
      fetchImpl: async () => response({ error: "no" }, 401),
      token: "test-secret"
    });
    assert.equal(snapshot.state, "unauthorized");
    assert.equal(snapshot.message?.includes("test-secret"), false);
  });

  it("marks runtime failures partial and deduplicates recent conversations", async () => {
    const threads = [
      {
        id: "t1",
        sessionId: uuid,
        name: "One",
        projectId: "p",
        projectName: "P",
        latestAt: "2026-09-21T10:00:00.000Z",
        threadKind: "conversation",
        sourceAiClient: "codex"
      },
      {
        id: "t2",
        sessionId: uuid,
        name: "Duplicate",
        projectId: "p",
        projectName: "P",
        latestAt: "2026-09-21T09:00:00.000Z",
        threadKind: "conversation",
        sourceAiClient: "codex"
      }
    ];
    const snapshot = await readHomeSnapshot({
      fetchImpl: async (url, init) => {
        const pathname = new URL(url).pathname;
        assert.equal(init.headers.authorization, "Bearer test-secret");
        if (pathname.endsWith("/access"))
          return response({ user: { id: "owner" } });
        if (pathname.endsWith("/managed-conversations"))
          return response({ executions: [execution] });
        if (pathname.endsWith("/runtime")) return response({}, 500);
        return response({ projects: [{ name: "P", threads }] });
      },
      token: "test-secret"
    });
    assert.equal(snapshot.state, "partial");
    assert.equal(snapshot.coverage.requests, false);
    assert.equal(snapshot.recents.length, 1);
  });

  it("keeps only pending actionable runtime requests", async () => {
    const snapshot = await readHomeSnapshot({
      fetchImpl: homeFetch({
        runtime: {
          items: [
            {
              id: "pending-approval",
              itemKind: "command_approval",
              state: "pending",
              answered: false
            },
            {
              id: "answered-input",
              itemKind: "user_input",
              state: "answered",
              answered: true
            },
            {
              id: "transient-output",
              itemKind: "transient_output",
              state: "pending",
              answered: false
            },
            {
              id: "resolved-input",
              itemKind: "user_input",
              state: "resolved",
              answered: false
            },
            null,
            {
              id: "pending-file",
              itemKind: "file_approval",
              state: "pending",
              answered: false
            }
          ]
        }
      }),
      token: "test-secret"
    });
    assert.deepEqual(
      snapshot.requests.map((item) => item.id),
      ["pending-approval", "pending-file"]
    );
  });

  it("caps aggregate requests deterministically across delayed executions", async () => {
    const executions = [
      {
        ...execution,
        id: "execution-a",
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      },
      {
        ...execution,
        id: "execution-b",
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      }
    ];
    const itemsFor = (executionId, start) =>
      Array.from({ length: 75 }, (_, index) => ({
        id: `${executionId}-request-${index}`,
        itemKind: "command_approval",
        state: "pending",
        answered: false,
        updatedAt: new Date(start + index * 1_000).toISOString()
      }));
    const items = {
      "execution-a": itemsFor(
        "execution-a",
        Date.parse("2026-09-21T10:00:00Z")
      ),
      "execution-b": itemsFor("execution-b", Date.parse("2026-09-21T11:00:00Z"))
    };
    const readWithDelays = (delays) => async (url, init) => {
      const parsed = new URL(url);
      const pathname = parsed.pathname;
      assert.equal(init.headers.authorization, "Bearer test-secret");
      if (pathname.endsWith("/access"))
        return response({ user: { id: "owner" } });
      if (pathname.endsWith("/managed-conversations"))
        return response({ executions });
      if (pathname.endsWith("/runtime")) {
        const executionId = pathname.split("/").at(-2);
        await new Promise((resolve) =>
          setTimeout(resolve, delays[executionId] ?? 0)
        );
        return response({ items: items[executionId] });
      }
      return response({ projects: [] });
    };
    const first = await readHomeSnapshot({
      fetchImpl: readWithDelays({ "execution-a": 30, "execution-b": 0 }),
      token: "test-secret"
    });
    const second = await readHomeSnapshot({
      fetchImpl: readWithDelays({ "execution-a": 0, "execution-b": 30 }),
      token: "test-secret"
    });
    assert.equal(first.requests.length, 100);
    assert.equal(first.coverage.requests, false);
    assert.ok(first.warnings.includes("Total request coverage is capped."));
    assert.deepEqual(
      first.requests.map((item) => item.id),
      second.requests.map((item) => item.id)
    );
    assert.equal(first.requests[0]?.id, "execution-b-request-74");
    assert.equal(first.requests.at(-1)?.id, "execution-a-request-50");
  });

  it("sorts recent conversations newest-first across projects", async () => {
    const snapshot = await readHomeSnapshot({
      fetchImpl: async (url, init) => {
        const pathname = new URL(url).pathname;
        assert.equal(init.headers.authorization, "Bearer test-secret");
        if (pathname.endsWith("/access"))
          return response({ user: { id: "owner" } });
        if (pathname.endsWith("/managed-conversations"))
          return response({ executions: [] });
        if (pathname.endsWith("/runtime")) return response({ items: [] });
        return response({
          projects: [
            {
              name: "Older",
              threads: [
                {
                  id: "old-thread",
                  sessionId: "old-session",
                  name: "Older",
                  latestAt: "2026-09-20T10:00:00.000Z",
                  threadKind: "conversation"
                }
              ]
            },
            {
              name: "Newer",
              threads: [
                {
                  id: "new-thread",
                  sessionId: "new-session",
                  name: "Newer",
                  latestAt: "2026-09-21T10:00:00.000Z",
                  threadKind: "conversation"
                }
              ]
            }
          ]
        });
      },
      token: "test-secret"
    });
    assert.deepEqual(
      snapshot.recents.map((item) => item.title),
      ["Newer", "Older"]
    );
  });

  it("serves only loopback same-origin Home APIs and allowlisted static paths", async () => {
    staticDir = await mkdtemp(join(tmpdir(), "koed-studio-test-"));
    await mkdir(join(staticDir, "agents"));
    await writeFile(join(staticDir, "index.html"), "home");
    await writeFile(join(staticDir, "plugins.html"), "plugins");
    await writeFile(join(staticDir, "pull-requests.html"), "pull requests");
    await writeFile(join(staticDir, "settings.html"), "settings");
    await writeFile(join(staticDir, "memory-inbox.html"), "memory inbox");
    await writeFile(join(staticDir, "collaboration.html"), "collaboration");
    await writeFile(
      join(staticDir, "personal-preview.html"),
      "personal preview"
    );
    await mkdir(join(staticDir, "personal-preview"));
    await writeFile(
      join(staticDir, "personal-preview", "__next._tree.txt"),
      "preview tree"
    );
    await writeFile(join(staticDir, "agents", "index.html"), "prototype");
    await writeFile(join(staticDir, "agents.html"), "agents");
    started = await startStudioServer({
      port: 0,
      staticDir,
      token: "test-secret",
      fetchImpl: homeFetch({ executions: [], threads: [] })
    });
    const sameOrigin = await get(`${started.url}/`);
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.body, "home");
    const gatewayPort = new URL(started.url).port;
    const exactOrigin = await get(`${started.url}/`, {
      origin: `http://127.0.0.1:${gatewayPort}`
    });
    assert.equal(exactOrigin.status, 200);
    const portlessOrigin = await get(`${started.url}/`, {
      origin: "http://127.0.0.1"
    });
    assert.equal(portlessOrigin.status, 403);
    const differentPortOrigin = await get(`${started.url}/`, {
      origin: `http://127.0.0.1:${Number(gatewayPort) + 1}`
    });
    assert.equal(differentPortOrigin.status, 403);
    const differentSchemeOrigin = await get(`${started.url}/`, {
      origin: `https://127.0.0.1:${gatewayPort}`
    });
    assert.equal(differentSchemeOrigin.status, 403);
    const differentHostOrigin = await get(`${started.url}/`, {
      origin: `http://localhost:${gatewayPort}`
    });
    assert.equal(differentHostOrigin.status, 403);
    const plugins = await get(`${started.url}/plugins`);
    assert.equal(plugins.status, 200);
    assert.equal(plugins.body, "plugins");
    const pullRequests = await get(`${started.url}/pull-requests`);
    assert.equal(pullRequests.status, 200);
    assert.equal(pullRequests.body, "pull requests");
    const importedRoute = await get(`${started.url}/agents`);
    assert.equal(importedRoute.status, 200);
    assert.equal(importedRoute.body, "agents");
    const settings = await get(`${started.url}/settings`);
    assert.equal(settings.status, 200);
    assert.equal(settings.body, "settings");
    const memoryInbox = await get(`${started.url}/memory-inbox`);
    assert.equal(memoryInbox.status, 200);
    assert.equal(memoryInbox.body, "memory inbox");
    const collaboration = await get(`${started.url}/collaboration`);
    assert.equal(collaboration.status, 200);
    assert.equal(collaboration.body, "collaboration");
    assert.equal(
      (await get(`${started.url}/studio-api/collaboration/snapshot`)).status,
      404
    );
    assert.equal(
      (await get(`${started.url}/studio-api/collaboration/session`)).status,
      404
    );
    const personalPreview = await get(`${started.url}/personal-preview`);
    assert.equal(personalPreview.status, 200);
    assert.equal(personalPreview.body, "personal preview");
    const prefetchedPage = await get(
      `${started.url}/personal-preview`,
      {},
      "HEAD"
    );
    assert.equal(prefetchedPage.status, 200);
    assert.equal(prefetchedPage.body, "");
    const prefetchedTree = await get(
      `${started.url}/personal-preview/__next._tree.txt`
    );
    assert.equal(prefetchedTree.status, 200);
    assert.equal(prefetchedTree.body, "preview tree");
    const encodedNestedAsset = await get(`${started.url}/nested%2Fsecret.js`);
    assert.equal(encodedNestedAsset.status, 404);
    const removedMemoryViewer = await get(
      `${started.url}/studio-api/conversation?sessionId=${uuid}`
    );
    assert.equal(removedMemoryViewer.status, 404);
    const evilHost = await get(`${started.url}/`, { host: "evil.example" });
    assert.equal(evilHost.status, 403);
  });

  it("serves a protected, projected collaboration snapshot from its callback", async () => {
    staticDir = await mkdtemp(
      join(tmpdir(), "koed-studio-collaboration-test-")
    );
    await writeFile(join(staticDir, "index.html"), "home");
    let calls = 0;
    started = await startStudioServer({
      port: 0,
      staticDir,
      loadCollaborationSnapshot: async () => {
        calls += 1;
        return {
          connection: {
            state: "live",
            backendId: "up_team_example",
            connectedAt: "2026-09-25T12:00:00.000Z",
            retryAt: null,
            reconnectAttempt: 0,
            protocolVersion: 1,
            apiToken: "nested-secret"
          },
          teams: [
            {
              id: "team-1",
              name: "Authorized Team",
              role: "member",
              unreadCount: 2,
              people: [
                {
                  id: "person-1",
                  displayName: "Colleague",
                  email: "private@example.test",
                  teamPresence: { activityLevel: "active" },
                  management: { access: "admin" }
                }
              ],
              workspaces: [
                {
                  id: "workspace-1",
                  name: "Authorized Workspace",
                  access: "write",
                  channels: [
                    {
                      id: "channel-1",
                      topic: "sensitive topic",
                      readReceipts: [{ userId: "person-1" }]
                    }
                  ],
                  sharedMemory: [{ id: "shared-memory-1", title: "Private" }]
                }
              ],
              directMessages: [{ id: "dm-1", latestMessage: "private" }],
              management: { access: "admin" }
            }
          ],
          apiToken: "top-level-secret"
        };
      }
    });
    const endpoint = `${started.url}/studio-api/collaboration/snapshot`;
    const response = await get(endpoint, { origin: started.url });
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.teams, [
      {
        id: "team-1",
        name: "Authorized Team",
        role: "member",
        unreadCount: 2,
        people: [{ id: "person-1", displayName: "Colleague" }],
        workspaces: [{ id: "workspace-1", name: "Authorized Workspace" }]
      }
    ]);
    assert.equal(body.apiToken, undefined);
    assert.equal(body.connection.apiToken, undefined);
    assert.equal(response.body.includes("secret"), false);
    for (const value of [
      "private@example.test",
      "sensitive topic",
      "readReceipts",
      "shared-memory-1",
      "dm-1",
      "management"
    ]) {
      assert.equal(response.body.includes(value), false);
    }
    assert.equal(calls, 1);

    const gatewayPort = new URL(started.url).port;
    const forbidden = await get(endpoint, {
      origin: `http://localhost:${gatewayPort}`
    });
    assert.equal(forbidden.status, 403);
    assert.equal(calls, 1);
    assert.equal(
      (await get(endpoint, { origin: started.url }, "POST")).status,
      405
    );
  });

  it("protects backend actions with exact Origin, CSRF, strict bodies, and one-use request IDs", async () => {
    staticDir = await mkdtemp(join(tmpdir(), "koed-studio-backend-actions-"));
    await writeFile(join(staticDir, "index.html"), "home");
    const calls = [];
    let current = {
      connection: {
        state: "disconnected",
        backendId: null,
        connectedAt: null,
        retryAt: null,
        reconnectAttempt: 0,
        protocolVersion: 1
      },
      teams: []
    };
    const toLive = () => {
      current = {
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
            id: "team-new",
            name: "New Team",
            role: "member",
            unreadCount: 0,
            people: [],
            workspaces: [],
            management: { secret: true }
          }
        ],
        privateCredential: "must-not-leak"
      };
      return current;
    };
    const callbacks = {
      loadCollaborationSnapshot: async () => current,
      connectCollaborationBackend: async (remoteUrl) => {
        calls.push(["connect", remoteUrl]);
        return toLive();
      },
      reconnectCollaborationBackend: async () => {
        calls.push(["reconnect"]);
        return current;
      },
      disconnectCollaborationBackend: async () => {
        calls.push(["disconnect"]);
        current = {
          connection: {
            state: "disconnected",
            backendId: null,
            connectedAt: null,
            retryAt: null,
            reconnectAttempt: 0,
            protocolVersion: 1
          },
          teams: []
        };
        return current;
      }
    };
    started = await startStudioServer({ port: 0, staticDir, ...callbacks });
    const origin = started.url;
    const sessionResponse = await get(
      `${origin}/studio-api/collaboration/session`,
      { origin }
    );
    assert.equal(sessionResponse.status, 200);
    const session = JSON.parse(sessionResponse.body);
    assert.equal(session.connection.state, "disconnected");
    assert.equal(typeof session.csrfToken, "string");
    assert.equal(session.privateCredential, undefined);
    assert.equal(
      (await get(`${origin}/studio-api/collaboration/session`)).status,
      200
    );
    const endpoint = `${origin}/studio-api/collaboration/backend`;
    const actionHeaders = {
      origin,
      "x-studio-csrf": session.csrfToken
    };

    assert.equal(
      (
        await sendJson(endpoint, {
          headers: {
            ...actionHeaders,
            origin: "http://localhost:" + new URL(origin).port
          },
          body: {
            action: "connect_backend",
            remoteUrl: "https://team.example.test",
            requestId: "11111111-1111-4111-8111-111111111111"
          }
        })
      ).status,
      403
    );
    assert.equal(
      (
        await sendJson(endpoint, {
          headers: actionHeaders,
          body: {
            action: "connect_backend",
            remoteUrl: "https://user:pass@team.example.test",
            requestId: "11111111-1111-4111-8111-111111111111"
          }
        })
      ).status,
      400
    );
    assert.equal(
      (
        await sendJson(endpoint, {
          headers: actionHeaders,
          body: {
            action: "connect_backend",
            remoteUrl: `https://team.example.test/${"a".repeat(4_000)}`,
            requestId: "11111111-1111-4111-8111-111111111116"
          }
        })
      ).status,
      413
    );
    assert.equal(
      (
        await sendJson(endpoint, {
          headers: actionHeaders,
          method: "GET",
          body: {}
        })
      ).status,
      405
    );
    assert.equal(
      (
        await sendJson(endpoint, {
          headers: { origin },
          body: {
            action: "reconnect_backend",
            requestId: "11111111-1111-4111-8111-111111111112"
          }
        })
      ).status,
      403
    );

    const connectBody = {
      action: "connect_backend",
      remoteUrl: "https://team.example.test",
      requestId: "11111111-1111-4111-8111-111111111113"
    };
    const connected = await sendJson(endpoint, {
      headers: actionHeaders,
      body: connectBody
    });
    assert.equal(connected.status, 200);
    const connectedDto = JSON.parse(connected.body);
    assert.equal(connectedDto.connection.state, "live");
    assert.equal(connectedDto.teams[0].name, "New Team");
    assert.equal(connectedDto.teams[0].management, undefined);
    assert.equal(connectedDto.privateCredential, undefined);
    assert.equal(connected.body.includes("must-not-leak"), false);
    assert.equal(
      (
        await sendJson(endpoint, {
          headers: actionHeaders,
          body: connectBody
        })
      ).status,
      409
    );
    const reconnected = await sendJson(endpoint, {
      headers: actionHeaders,
      body: {
        action: "reconnect_backend",
        requestId: "11111111-1111-4111-8111-111111111114"
      }
    });
    assert.equal(JSON.parse(reconnected.body).connection.state, "live");
    const disconnected = await sendJson(endpoint, {
      headers: actionHeaders,
      body: {
        action: "disconnect_backend",
        requestId: "11111111-1111-4111-8111-111111111115"
      }
    });
    assert.equal(JSON.parse(disconnected.body).teams.length, 0);
    assert.equal(
      JSON.parse(disconnected.body).connection.state,
      "disconnected"
    );
    assert.deepEqual(calls, [
      ["connect", "https://team.example.test"],
      ["reconnect"],
      ["disconnect"]
    ]);
  });

  it("returns a generic error when the collaboration callback fails", async () => {
    staticDir = await mkdtemp(
      join(tmpdir(), "koed-studio-collaboration-error-")
    );
    await writeFile(join(staticDir, "index.html"), "home");
    started = await startStudioServer({
      port: 0,
      staticDir,
      loadCollaborationSnapshot: async () => {
        throw new Error("private credential details");
      }
    });
    const response = await get(
      `${started.url}/studio-api/collaboration/snapshot`
    );
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), {
      error: "collaboration_unavailable"
    });
    assert.equal(response.body.includes("private credential details"), false);
  });

  it("serves bounded local discovery without exposing a generic filesystem request", async () => {
    staticDir = await mkdtemp(join(tmpdir(), "koed-studio-catalog-test-"));
    await writeFile(join(staticDir, "index.html"), "home");
    const calls = [];
    started = await startStudioServer({
      port: 0,
      staticDir,
      listLocalSources: async (query) => {
        calls.push(query);
        return {
          items: [
            {
              sourceId: "codex:old",
              provider: "codex",
              title: "Old",
              activityAt: "2020-01-01T00:00:00.000Z"
            }
          ],
          nextCursor: null,
          providers: {
            codex: { status: "available" },
            "claude-code": { status: "unavailable" },
            pi: { status: "unavailable" }
          },
          truncated: false
        };
      }
    });
    const listed = await get(
      `${started.url}/studio-api/local-conversations?limit=1&provider=codex`
    );
    assert.equal(listed.status, 200);
    assert.deepEqual(calls, [
      { limit: 1, cursor: undefined, provider: "codex" }
    ]);
    assert.equal(JSON.parse(listed.body).items[0].sourceId, "codex:old");
    assert.equal(
      (await get(`${started.url}/studio-api/local-conversations?limit=101`))
        .status,
      400
    );
    assert.equal(
      (
        await get(
          `${started.url}/studio-api/local-conversations?path=%2Fsecret`
        )
      ).status,
      400
    );
    assert.equal(
      (await get(`${started.url}/studio-api/local-conversations`, {}, "POST"))
        .status,
      405
    );
    assert.equal(calls.length, 1);
  });

  it("serves local Projects and conversation summaries when Koed is offline, then recovers Home", async () => {
    staticDir = await mkdtemp(join(tmpdir(), "koed-studio-offline-catalog-"));
    await writeFile(join(staticDir, "index.html"), "home");
    const home = await mkdtemp(join(tmpdir(), "koed-studio-koed-home-"));
    const localHome = await mkdtemp(join(tmpdir(), "koed-studio-local-home-"));
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(
      join(home, "config", "projects.json"),
      JSON.stringify({
        schemaVersion: 3,
        updatedAt: "2026-09-21T10:00:00.000Z",
        deviceSaltId: "device-salt",
        projects: [
          {
            schemaVersion: 1,
            discoveredAt: "2026-09-20T10:00:00.000Z",
            lastSeenAt: "2026-09-21T10:00:00.000Z",
            localProjectId: `lp_${"a".repeat(32)}`,
            displayName: "Local Project",
            path: {
              cwd: "/private/local-project",
              projectRoot: "/private/local-project",
              basename: "local-project",
              localPathHash: "path-hash"
            },
            packages: []
          }
        ]
      })
    );
    const codexRoot = join(localHome, ".codex", "sessions");
    await mkdir(codexRoot, { recursive: true });
    await writeFile(
      join(codexRoot, "session.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "local-session",
          cwd: "/private/local-project",
          title: "Local Codex conversation"
        }
      })}\n`
    );
    await writeFile(
      join(codexRoot, "older-session.jsonl"),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "older-local-session",
          cwd: "/private/local-project",
          title: "Older local conversation"
        }
      })}\n`
    );
    let backendOnline = false;
    const fetchImpl = async (...args) => {
      if (!backendOnline) throw new Error("connection refused");
      return homeFetch({ executions: [], threads: [] })(...args);
    };
    started = await startStudioServer({
      port: 0,
      staticDir,
      token: "test-secret",
      environment: { KOED_HOME: home, HOME: localHome },
      fetchImpl
    });

    const offlineHome = JSON.parse(
      (await get(`${started.url}/studio-api/home`)).body
    );
    assert.equal(offlineHome.state, "unavailable");
    const catalogResponse = await get(
      `${started.url}/studio-api/local-conversations?provider=codex&limit=1`
    );
    assert.equal(catalogResponse.status, 200);
    const catalog = JSON.parse(catalogResponse.body);
    assert.equal(catalog.items.length, 1);
    assert.ok(catalog.nextCursor);
    assert.equal(catalog.providers.codex.status, "available");
    const nextPage = await get(
      `${started.url}/studio-api/local-conversations?provider=codex&limit=1&cursor=${encodeURIComponent(catalog.nextCursor)}`
    );
    assert.equal(nextPage.status, 200);
    assert.equal(JSON.parse(nextPage.body).items.length, 1);
    assert.notEqual(
      JSON.parse(nextPage.body).items[0].sourceId,
      catalog.items[0].sourceId
    );
    const projectsResponse = await get(`${started.url}/studio-api/projects`);
    assert.equal(projectsResponse.status, 200);
    assert.deepEqual(JSON.parse(projectsResponse.body), {
      projects: [
        {
          id: `lp_${"a".repeat(32)}`,
          name: "Local Project",
          lastSeenAt: "2026-09-21T10:00:00.000Z"
        }
      ]
    });
    assert.equal(catalogResponse.body.includes("test-secret"), false);
    assert.equal(
      projectsResponse.body.includes("/private/local-project"),
      false
    );
    assert.equal(
      (
        await get(`${started.url}/studio-api/projects`, {
          origin: "https://evil.example"
        })
      ).status,
      403
    );

    backendOnline = true;
    const recoveredHome = JSON.parse(
      (await get(`${started.url}/studio-api/home`)).body
    );
    assert.equal(recoveredHome.state, "ready");
    await rm(home, { recursive: true, force: true });
    await rm(localHome, { recursive: true, force: true });
  });

  it("accepts a main-process token resolver without returning its value to Studio", async () => {
    staticDir = await mkdtemp(join(tmpdir(), "koed-studio-token-test-"));
    await writeFile(join(staticDir, "index.html"), "home");
    let reads = 0;
    started = await startStudioServer({
      port: 0,
      staticDir,
      resolveToken: async () => {
        reads += 1;
        return "test-secret";
      },
      fetchImpl: homeFetch({ executions: [], threads: [] })
    });
    const result = await get(`${started.url}/studio-api/home`);
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).state, "ready");
    assert.equal(result.body.includes("test-secret"), false);
    assert.equal(reads, 1);
  });

  it("resolves an older local source only through an exact owner-scoped graph match", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(url);
      calls.push(parsed);
      assert.equal(init.headers.authorization, "Bearer test-secret");
      return response({
        projects: [
          {
            name: "Example",
            threads: [
              {
                id: "native-old",
                sessionId: uuid,
                threadKind: "conversation",
                sourceAiClient: "codex-cli",
                name: "Old conversation",
                projectName: "Example",
                latestAt: "2020-01-01T00:00:00.000Z"
              }
            ]
          }
        ]
      });
    };
    const captured = await resolveLocalConversationCapture({
      sourceId: "codex:native-old",
      token: "test-secret",
      fetchImpl
    });
    assert.deepEqual(captured, {
      state: "captured",
      sessionId: uuid,
      title: "Old conversation",
      projectName: "Example",
      provider: "codex-cli"
    });
    assert.equal(calls[0].searchParams.get("threadId"), "native-old");
    const wrongProvider = await resolveLocalConversationCapture({
      sourceId: "pi:native-old",
      token: "test-secret",
      fetchImpl
    });
    assert.deepEqual(wrongProvider, { state: "not_captured" });
    assert.deepEqual(
      await resolveLocalConversationCapture({
        sourceId: "codex:%E0%A4%A",
        token: "test-secret",
        fetchImpl
      }),
      { state: "invalid" }
    );
  });

  it("uses paired local access for conversation capture resolution", async () => {
    let called = false;
    const captured = await resolveLocalConversationCapture({
      sourceId: "codex:native-old",
      apiBase: "http://127.0.0.1:43300",
      resolveAccess: async () => ({
        apiOrigin: "http://127.0.0.1:59451",
        apiToken: "capture-paired-token"
      }),
      fetchImpl: async (url, init) => {
        called = true;
        assert.equal(new URL(url).origin, "http://127.0.0.1:59451");
        assert.equal(init.headers.authorization, "Bearer capture-paired-token");
        return response({
          projects: [
            {
              name: "Example",
              threads: [
                {
                  id: "native-old",
                  sessionId: uuid,
                  threadKind: "conversation",
                  sourceAiClient: "codex-cli",
                  name: "Old conversation",
                  projectName: "Example"
                }
              ]
            }
          ]
        });
      }
    });
    assert.equal(called, true);
    assert.equal(captured.state, "captured");
  });

  it("scopes Home state to backend origin and user, without the token", async () => {
    const fetchImpl = async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/access"))
        return response({ user: { id: "owner" } });
      if (pathname.endsWith("/managed-conversations"))
        return response({ executions: [] });
      return response({ projects: [{ name: "Personal", threads: [] }] });
    };
    const first = await readHomeSnapshot({
      apiBase: "http://127.0.0.1:43300/",
      fetchImpl,
      token: "first-secret"
    });
    const second = await readHomeSnapshot({
      apiBase: "http://127.0.0.1:43301/",
      fetchImpl,
      token: "second-secret"
    });
    assert.equal(first.scopeKey, "http://127.0.0.1:43300|owner");
    assert.equal(second.scopeKey, "http://127.0.0.1:43301|owner");
    assert.equal(first.scopeKey?.includes("secret"), false);
    assert.equal(second.scopeKey?.includes("secret"), false);
  });

  it("keeps one paired access for the full Home snapshot", async () => {
    let accessCalls = 0;
    const requests = [];
    const snapshot = await readHomeSnapshot({
      apiBase: "http://127.0.0.1:43300",
      resolveAccess: async () => {
        accessCalls += 1;
        return accessCalls === 1
          ? {
              apiOrigin: "http://127.0.0.1:59451",
              apiToken: "first-paired-token"
            }
          : {
              apiOrigin: "http://127.0.0.1:59452",
              apiToken: "next-paired-token"
            };
      },
      fetchImpl: async (url, init) => {
        const parsed = new URL(url);
        requests.push({
          origin: parsed.origin,
          token: init.headers.authorization
        });
        if (parsed.pathname.endsWith("/access"))
          return response({ user: { id: "owner" } });
        if (parsed.pathname.endsWith("/managed-conversations"))
          return response({ executions: [] });
        return response({ projects: [] });
      }
    });

    assert.equal(accessCalls, 1);
    assert.equal(snapshot.scopeKey, "http://127.0.0.1:59451|owner");
    assert.deepEqual(requests, [
      {
        origin: "http://127.0.0.1:59451",
        token: "Bearer first-paired-token"
      },
      {
        origin: "http://127.0.0.1:59451",
        token: "Bearer first-paired-token"
      },
      {
        origin: "http://127.0.0.1:59451",
        token: "Bearer first-paired-token"
      }
    ]);
  });

  it("recovers paired local access without restarting the gateway or using its fallback origin", async () => {
    staticDir = await mkdtemp(join(tmpdir(), "koed-studio-access-test-"));
    await writeFile(join(staticDir, "index.html"), "Studio is ready");
    let accessState = "unavailable";
    const requests = [];
    started = await startStudioServer({
      port: 0,
      staticDir,
      apiBase: "http://127.0.0.1:43300",
      resolveAccess: async () => {
        if (accessState === "unavailable") throw new Error("not_ready");
        return accessState === "invalid"
          ? {
              apiOrigin: "https://example.invalid",
              apiToken: "private-token"
            }
          : {
              apiOrigin: "http://127.0.0.1:59451",
              apiToken: "private-token"
            };
      },
      fetchImpl: async (url, init) => {
        requests.push({
          url: new URL(url),
          authorization: init.headers.authorization
        });
        return response({ executions: [] });
      }
    });

    assert.equal((await get(`${started.url}/`)).body, "Studio is ready");
    assert.equal(requests.length, 0, "static routes do not require backend access");

    const unavailable = await get(
      `${started.url}/studio-api/managed-conversations`
    );
    assert.equal(unavailable.status, 503);
    assert.equal(
      requests.length,
      0,
      "readiness failure must not contact the fallback"
    );

    accessState = "healthy";
    const recovered = await get(
      `${started.url}/studio-api/managed-conversations`
    );
    assert.equal(recovered.status, 200);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.origin, "http://127.0.0.1:59451");
    assert.equal(requests[0].authorization, "Bearer private-token");

    accessState = "invalid";
    const invalid = await get(
      `${started.url}/studio-api/managed-conversations`
    );
    assert.equal(invalid.status, 503);
    assert.equal(requests.length, 1, "invalid origins must not receive the token");
  });
});
