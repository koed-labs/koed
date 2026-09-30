import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handlePublicSquare } from "./personal-agents-http.mjs";

const team = "11111111-1111-4111-8111-111111111111";
const publication = "22222222-2222-4222-8222-222222222222";
const prefix = `/studio-api/public-square/teams/${team}`;

async function call({
  method = "GET",
  path = prefix,
  body = {},
  ...overrides
} = {}) {
  let result;
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.headers = { "content-type": "application/json" };
  const handled = await handlePublicSquare({
    request,
    url: new URL(path, "http://localhost"),
    validCsrf: () => true,
    resolveToken: async () => "private-runtime-token",
    apiBase: "http://127.0.0.1:43300",
    fetchImpl: async () => Response.json({ teamId: team, items: [] }),
    ...overrides,
    send: (status, payload) => {
      result = { status, payload };
    }
  });
  return { handled, ...result };
}

test("Square reads preserve Team scope and pagination through paired local authority", async () => {
  const result = await call({
    path: `${prefix}?limit=5&cursor=opaque-page`,
    resolveAccess: async () => ({
      apiOrigin: "http://127.0.0.1:43400",
      apiToken: "paired-private-token"
    }),
    fetchImpl: async (url, init) => {
      assert.equal(
        url.href,
        `http://127.0.0.1:43400/v1/collaboration/teams/${team}/public-square?limit=5&cursor=opaque-page`
      );
      assert.equal(init.headers.authorization, "Bearer paired-private-token");
      assert.equal(init.redirect, "error");
      return Response.json({ teamId: team, items: [] });
    }
  });
  assert.equal(result.status, 200);
});

test("Square mutations require CSRF before resolving credentials or sending", async () => {
  const result = await call({
    method: "PUT",
    path: `${prefix}/${publication}/brief`,
    validCsrf: () => false,
    resolveToken: () => assert.fail("must not resolve credentials"),
    fetchImpl: () => assert.fail("must not send")
  });
  assert.equal(result.status, 403);
});

test("withdrawal forwards the exact expected version and null brief", async () => {
  const result = await call({
    method: "PUT",
    path: `${prefix}/${publication}/brief`,
    body: { expectedVersion: 7, brief: null },
    fetchImpl: async (url, init) => {
      assert.equal(
        url.pathname,
        `/v1/collaboration/teams/${team}/public-square/${publication}/brief`
      );
      assert.equal(init.method, "PUT");
      assert.equal(init.body, '{"expectedVersion":7,"brief":null}');
      return Response.json({ withdrawn: true });
    }
  });
  assert.equal(result.status, 200);
});

test("rejects route and query overrides before sending", async () => {
  for (const path of [
    `${prefix}/anything`,
    `${prefix}/${publication}/conversation`,
    `${prefix}?owner=someone-else`,
    `${prefix}?limit=5&limit=10`,
    `${prefix}?limit=101`,
    `${prefix}?cursor=`,
    `${prefix}/${publication}/brief-draft?teamId=other`
  ]) {
    const result = await call({
      path,
      fetchImpl: () => assert.fail("must not send")
    });
    assert.ok([400, 404].includes(result.status), path);
  }
});

test("does not widen the private draft endpoint to writes", async () => {
  const result = await call({
    method: "PUT",
    path: `${prefix}/${publication}/brief-draft`,
    fetchImpl: () => assert.fail("must not send")
  });
  assert.equal(result.status, 405);
});

test("fails closed on missing local authorization and sanitizes backend errors", async () => {
  assert.equal((await call({ resolveToken: async () => null })).status, 401);
  assert.equal(
    (await call({ apiBase: "https://untrusted.example" })).status,
    503
  );
  const result = await call({
    fetchImpl: async () =>
      new Response("private prompt and credentials", { status: 403 })
  });
  assert.equal(result.status, 403);
  assert.ok(!JSON.stringify(result).includes("private prompt"));
});
