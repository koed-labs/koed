import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
// @ts-expect-error -- Node's native TypeScript runner requires the source extension.
import { StudioCollaborationSettingsClient } from "./studio-collaboration-settings.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Studio collaboration settings client", () => {
  it("loads the Desktop session and sends only the selected action with CSRF", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/session"))
        return new Response(
          JSON.stringify({
            csrfToken: "session-token",
            connection: {
              state: "disconnected",
              backendId: null,
              connectedAt: null,
              retryAt: null,
              reconnectAttempt: 0,
              protocolVersion: 1
            },
            teams: []
          }),
          { status: 200 }
        );
      return new Response(
        JSON.stringify({
          connection: {
            state: "live",
            backendId: "up_team_example",
            connectedAt: "2026-09-25T12:00:00.000Z",
            retryAt: null,
            reconnectAttempt: 0,
            protocolVersion: 1
          },
          teams: []
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const client = new StudioCollaborationSettingsClient();
    await client.load();
    const connected = await client.connect("https://team.example.test");
    assert.equal(connected.connection.state, "live");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, "/studio-api/collaboration/session");
    assert.equal(requests[1]?.url, "/studio-api/collaboration/backend");
    assert.equal(
      new Headers(requests[1]?.init?.headers).get("x-studio-csrf"),
      "session-token"
    );
    const body = JSON.parse(String(requests[1]?.init?.body));
    assert.equal(body.action, "connect_backend");
    assert.equal(body.remoteUrl, "https://team.example.test");
    assert.match(body.requestId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(Object.keys(body).sort(), [
      "action",
      "remoteUrl",
      "requestId"
    ]);
  });

  it("clearly reports that hosted browser builds cannot connect a backend", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 404 })) as typeof fetch;
    await assert.rejects(
      new StudioCollaborationSettingsClient().load(),
      /available in Koed Desktop/
    );
  });
});
