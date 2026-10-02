import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handlePullRequests } from "./pull-requests-http.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const invoke = async (path, method = "GET", options = {}) => {
  let response, forwarded;
  const request = Readable.from(
    method === "GET" ? [] : [JSON.stringify({ expectedRevision: 1 })]
  );
  Object.assign(request, {
    method,
    headers: { "content-type": "application/json" }
  });
  await handlePullRequests({
    request,
    url: new URL(path, "http://127.0.0.1:43110"),
    validCsrf: () => true,
    resolveAccess: () => ({ apiOrigin: "http://127.0.0.1:9010" }),
    fetchImpl: async (url, init) => {
      forwarded = { url: String(url), init };
      return new Response(JSON.stringify({ ok: true }));
    },
    resolveCredential: () => ({
      authorization: "Koed-Desktop private-fixture",
      operationFamilies: ["managed_source_control"]
    }),
    send: (status, body) => {
      response = { status, body };
    },
    ...options
  });
  return { response, forwarded };
};
test("typed PR routes keep native credential on server and reject arbitrary suffixes", async () => {
  const { response, forwarded } = await invoke(
    `/studio-api/pull-requests/${id}/draft/freeze`,
    "POST"
  );
  assert.equal(response.status, 200);
  assert.equal(
    forwarded.url,
    `http://127.0.0.1:9010/v1/pull-requests/${id}/draft/freeze`
  );
  assert.equal(
    forwarded.init.headers.authorization,
    "Koed-Desktop private-fixture"
  );
  assert.ok(!JSON.stringify(response).includes("private-fixture"));
  assert.equal(
    (await invoke("/studio-api/pull-requests/../../admin", "POST")).forwarded,
    undefined
  );
  assert.equal(
    (await invoke(`/studio-api/pull-requests/${id}/execute`, "POST")).response
      .status,
    404
  );
});
test("writes require CSRF and configured scoped credentials", async () => {
  assert.equal(
    (
      await invoke("/studio-api/pull-requests/operations", "POST", {
        validCsrf: () => false
      })
    ).response.status,
    403
  );
  const denied = await invoke("/studio-api/pull-requests/operations", "POST", {
    resolveCredential: () => ({
      authorization: "secret",
      operationFamilies: []
    })
  });
  assert.equal(denied.response.status, 503);
  assert.equal(denied.forwarded, undefined);
});
test("proxy never forwards to a renderer supplied remote origin or arbitrary query", async () => {
  const denied = await invoke("/studio-api/pull-requests", "GET", {
    resolveAccess: () => ({ apiOrigin: "https://evil.example" })
  });
  assert.equal(denied.response.status, 503);
  assert.equal(denied.forwarded, undefined);
  assert.equal(
    (await invoke("/studio-api/pull-requests?token=secret")).response.status,
    400
  );
});
test("native approval controls stay on typed local endpoints", async () => {
  assert.equal(
    (await invoke("/studio-api/pull-requests/runners")).response.status,
    200
  );
  assert.equal(
    (await invoke("/studio-api/pull-requests/runners", "POST")).response.status,
    405
  );
  for (const path of [
    "/studio-api/pull-requests/action-grants",
    `/studio-api/pull-requests/action-grants/${id}`
  ]) {
    assert.equal((await invoke(path, "POST")).response.status, 200);
    assert.equal((await invoke(path, "GET")).response.status, 405);
    assert.equal(
      (await invoke(path, "POST", { validCsrf: () => false })).response.status,
      403
    );
  }
});

test("frozen publication previews can recover by owner read only", async () => {
  assert.equal(
    (await invoke(`/studio-api/pull-requests/${id}/draft/frozen`)).response
      .status,
    200
  );
  assert.equal(
    (await invoke(`/studio-api/pull-requests/${id}/draft/frozen`, "POST"))
      .response.status,
    405
  );
});
