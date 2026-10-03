import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  handleClientResources,
  handleManagedConversations
} from "./personal-agents-http.mjs";

async function call(path, method = "GET", overrides = {}) {
  let result;
  const request = Object.assign(
    Readable.from(
      method === "POST"
        ? [
            Buffer.from(
              '{"hostedInstanceId":"local","projectId":null,"requestId":"11111111-1111-4111-8111-111111111111"}'
            )
          ]
        : []
    ),
    {
      method,
      headers: { "content-type": "application/json" }
    }
  );
  const handled = await handleClientResources({
    request,
    url: new URL(`http://localhost/studio-api/ai-client-resources${path}`),
    validCsrf: () => true,
    resolveToken: async () => "owner-token",
    apiBase: "http://127.0.0.1:43300",
    fetchImpl: async () => Response.json({ state: "pending" }),
    ...overrides,
    send: (status, body) => {
      result = { status, body };
    }
  });
  return { handled, ...result };
}

test("native resource discovery shares owner authentication and exact route allowlist", async () => {
  for (const [path, method, upstream] of [
    ["/instances", "GET", "/v1/memory/local-agent-settings"],
    ["/discover", "POST", "/v1/ai-client-resources/discover"],
    [
      "/discover/11111111-1111-4111-8111-111111111111",
      "GET",
      "/v1/ai-client-resources/discover/11111111-1111-4111-8111-111111111111"
    ]
  ]) {
    const result = await call(path, method, {
      fetchImpl: async (url, init) => {
        assert.equal(url.pathname, upstream);
        assert.equal(init.headers.authorization, "Bearer owner-token");
        assert.equal(init.redirect, "error");
        assert.equal(init.method, method);
        return Response.json({ state: "pending" });
      }
    });
    assert.equal(result.status, 200);
  }
});
test("discovery writes reject forged CSRF before forwarding", async () => {
  assert.equal(
    (
      await call("/discover", "POST", {
        validCsrf: () => false,
        fetchImpl: () => assert.fail("unauthorized forwarding")
      })
    ).status,
    403
  );
});
test("resource proxy denies query impersonation, unknown operations and unsafe upstream", async () => {
  const neverFetch = { fetchImpl: () => assert.fail("unexpected forwarding") };
  assert.equal(
    (await call("/instances?ownerId=other", "GET", neverFetch)).status,
    400
  );
  assert.equal(
    (await call("/discover/other-owner", "GET", neverFetch)).status,
    404
  );
  assert.equal((await call("/install", "POST", neverFetch)).status, 404);
  assert.equal((await call("/discover", "GET", neverFetch)).status, 405);
  assert.equal(
    (
      await call("/instances", "GET", {
        ...neverFetch,
        apiBase: "https://attacker.example"
      })
    ).status,
    503
  );
});

test("Build reads forward only an exact owner-authenticated Job query", async () => {
  const executionId = "11111111-1111-4111-8111-111111111111";
  const jobId = "22222222-2222-4222-8222-222222222222";
  async function read(query, method = "GET") {
    let result;
    await handleManagedConversations({
      request: Object.assign(Readable.from([]), { method, headers: {} }),
      url: new URL(
        `http://localhost/studio-api/managed-conversations/${executionId}/build-progress${query}`
      ),
      apiBase: "http://127.0.0.1:43300",
      validCsrf: () => false,
      resolveToken: async () => "owner-token",
      fetchImpl: async (url, init) => {
        assert.equal(query, `?jobId=${jobId}`);
        assert.equal(
          url.pathname,
          `/v1/managed-conversations/${executionId}/build-progress`
        );
        assert.equal(url.search, query);
        assert.equal(init.headers.authorization, "Bearer owner-token");
        return Response.json({ jobId, events: [] });
      },
      send: (status, body) => {
        result = { status, body };
      }
    });
    return result.status;
  }
  assert.equal(await read(`?jobId=${jobId}`), 200);
  for (const query of [
    "",
    "?jobId=invalid",
    `?jobId=${jobId}&jobId=${jobId}`,
    `?jobId=${jobId}&ownerId=other`,
    `?other=${jobId}`
  ]) {
    assert.equal(await read(query), 400);
  }
  assert.equal(await read(`?jobId=${jobId}`, "POST"), 405);
});
