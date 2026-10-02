import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleHomeFeed } from "./personal-agents-http.mjs";

const event = "job:11111111-1111-4111-8111-111111111111";
async function invoke(path = "/studio-api/home-feed", options = {}) {
  let response;
  let forwarded;
  const method = options.method ?? "GET";
  const request = Object.assign(
    Readable.from(
      method === "GET"
        ? []
        : [Buffer.from(options.body ?? '{"sourceRevision":"job:1"}')]
    ),
    { method, headers: { "content-type": "application/json" } }
  );
  const handled = await handleHomeFeed({
    request,
    url: new URL(path, "http://127.0.0.1:43110"),
    validCsrf: () => true,
    resolveAccess: async () => ({
      apiOrigin: "http://127.0.0.1:43300",
      apiToken: "private-owner-credential"
    }),
    fetchImpl: async (url, init) => {
      forwarded = { url: url.href, init };
      return Response.json({ accountScope: "opaque-owner", badgeCount: 1 });
    },
    ...options,
    send: (status, body) => {
      response = { status, body };
    }
  });
  return { handled, response, forwarded };
}

test("Home feed reuses server-owned local authority without exposing credentials", async () => {
  const result = await invoke();
  assert.equal(result.handled, true);
  assert.equal(result.forwarded.url, "http://127.0.0.1:43300/v1/home");
  assert.equal(
    result.forwarded.init.headers.authorization,
    "Bearer private-owner-credential"
  );
  assert.equal(result.forwarded.init.redirect, "error");
  assert.equal(result.response.body.badgeCount, 1);
  assert.ok(
    !JSON.stringify(result.response).includes("private-owner-credential")
  );
});

test("Home reminder mutations require CSRF and preserve exact source revision", async () => {
  const path = `/studio-api/home-feed/reminders/${encodeURIComponent(event)}/clear`;
  const denied = await invoke(path, { method: "POST", validCsrf: () => false });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.forwarded, undefined);
  const accepted = await invoke(path, { method: "POST" });
  assert.equal(
    accepted.forwarded.url,
    `http://127.0.0.1:43300/v1/home/reminders/${encodeURIComponent(event)}/clear`
  );
  assert.equal(accepted.forwarded.init.body, '{"sourceRevision":"job:1"}');
  assert.equal(
    (await invoke(path.replace("/clear", "/restore"), { method: "POST" }))
      .response.status,
    200
  );
  const pushEvent = "pr-op:22222222-2222-4222-8222-222222222222";
  const push = await invoke(
    `/studio-api/home-feed/reminders/${encodeURIComponent(pushEvent)}/clear`,
    { method: "POST", body: '{"sourceRevision":"v1.o2"}' }
  );
  assert.equal(
    push.forwarded.url,
    `http://127.0.0.1:43300/v1/home/reminders/${encodeURIComponent(pushEvent)}/clear`
  );
});

test("Home access verifies the same fixed authority before loading the feed", async () => {
  const result = await invoke("/studio-api/home-feed/access");
  assert.equal(result.forwarded.url, "http://127.0.0.1:43300/v1/home/access");
  assert.equal(result.response.status, 200);
  assert.equal(
    (await invoke("/studio-api/home-feed/access?owner=other")).response.status,
    400
  );
});

test("Home proxy rejects arbitrary paths, queries, methods and remote origins", async () => {
  for (const path of [
    "/studio-api/home-feed/execute",
    "/studio-api/home-feed/reminders/a%2fb/clear",
    "/studio-api/home-feed/reminders/a%0a/clear"
  ])
    assert.equal((await invoke(path)).response.status, 404);
  assert.equal(
    (await invoke("/studio-api/home-feed?owner=another")).response.status,
    400
  );
  assert.equal(
    (await invoke(undefined, { method: "POST" })).response.status,
    405
  );
  assert.equal(
    (
      await invoke(undefined, {
        resolveAccess: async () => ({
          apiOrigin: "https://evil.example",
          apiToken: "secret"
        })
      })
    ).response.status,
    503
  );
});

test("Home keeps stale-source conflicts and authorization failures observable", async () => {
  for (const status of [401, 403, 409]) {
    const result = await invoke(undefined, {
      fetchImpl: async () =>
        Response.json({ error: "private diagnostic" }, { status })
    });
    assert.equal(result.response.status, status);
    assert.ok(!JSON.stringify(result.response).includes("private diagnostic"));
  }
});

test("Home reminder bodies are bounded before reaching account authority", async () => {
  const result = await invoke(
    `/studio-api/home-feed/reminders/${event}/clear`,
    {
      method: "POST",
      body: JSON.stringify({ sourceRevision: "x".repeat(5000) })
    }
  );
  assert.equal(result.response.status, 413);
  assert.equal(result.forwarded, undefined);
});

test("Home source paging forwards only bounded cursor queries", async () => {
  const path =
    "/studio-api/home-feed?source=personal_agent_job&cursor=ZXZlbnQ&limit=100";
  const result = await invoke(path);
  assert.equal(
    result.forwarded.url,
    "http://127.0.0.1:43300/v1/home?source=personal_agent_job&cursor=ZXZlbnQ&limit=100"
  );
  for (const query of [
    "source=unknown",
    "cursor=ZXZlbnQ",
    "source=personal_agent_job&limit=101",
    "source=personal_agent_job&cursor=x&cursor=y",
    "source=personal_agent_job&cursor=a%0Ab"
  ])
    assert.equal(
      (await invoke(`/studio-api/home-feed?${query}`)).response.status,
      400
    );
  assert.equal(
    (
      await invoke(
        `/studio-api/home-feed/reminders/${event}/clear?source=personal_agent_job`,
        { method: "POST" }
      )
    ).response.status,
    400
  );
});
