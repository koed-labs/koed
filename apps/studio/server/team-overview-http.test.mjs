import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleTeamAgentRequests } from "./personal-agents-http.mjs";

const team = "22222222-2222-4222-8222-222222222222";
async function call(path, overrides = {}) {
  let result;
  const request = Object.assign(
    Readable.from([Buffer.from('{"sourceRevision":"7"}')]),
    { method: "GET", headers: { "content-type": "application/json" } }
  );
  await handleTeamAgentRequests({
    request,
    url: new URL(`http://localhost/studio-api/collaboration${path}`),
    validCsrf: () => true,
    resolveAccess: async () => ({
      apiOrigin: "http://127.0.0.1:43300",
      apiToken: "server-owned-token"
    }),
    fetchImpl: async () => Response.json({}),
    send: (status, body) => {
      result = { status, body };
    },
    ...overrides
  });
  return result;
}

test("Team overview uses existing server-owned collaboration authority", async () => {
  let called = false;
  const result = await call("/teams/overview?limit=20&cursor=next", {
    fetchImpl: async (url, init) => {
      called = true;
      assert.equal(
        url.pathname + url.search,
        "/v1/collaboration/teams/overview?limit=20&cursor=next"
      );
      assert.equal(init.headers.authorization, "Bearer server-owned-token");
      assert.equal(init.redirect, "error");
      return Response.json({ badgeCount: 4 });
    }
  });
  assert.equal(called, true);
  assert.deepEqual(result, { status: 200, body: { badgeCount: 4 } });
});

test("overview queries cannot override scope and reject duplicate or excessive paging", async () => {
  for (const query of [
    "owner=other",
    "teamId=other",
    "limit=101",
    "limit=1&limit=2",
    "cursor=",
    "cursor=a&cursor=b"
  ]) {
    assert.equal(
      (
        await call(`/teams/overview?${query}`, {
          fetchImpl: () => assert.fail("invalid query must not reach authority")
        })
      ).status,
      400
    );
  }
});

test("exact reminder and seen mutations preserve revision and CSRF", async () => {
  for (const action of ["clear", "restore", "seen"]) {
    const request = Object.assign(
      Readable.from([Buffer.from('{"sourceRevision":"7"}')]),
      {
        method: "POST",
        headers: { "content-type": "application/json" }
      }
    );
    const path = `/teams/${team}/overview/job%3Aevent-1/${action}`;
    assert.equal(
      (
        await call(path, {
          request,
          fetchImpl: async (url, init) => {
            assert.equal(
              url.pathname,
              `/v1/collaboration/teams/${team}/overview/job%3Aevent-1/${action}`
            );
            assert.equal(init.body, '{"sourceRevision":"7"}');
            return Response.json({ applied: true });
          }
        })
      ).status,
      200
    );
    const blockedRequest = Object.assign(Readable.from([]), {
      method: "POST",
      headers: { "content-type": "application/json" }
    });
    assert.equal(
      (
        await call(path, {
          request: blockedRequest,
          validCsrf: () => false,
          fetchImpl: () => assert.fail("CSRF denied before authority")
        })
      ).status,
      403
    );
  }
});

test("overview proxy rejects encoded path escapes and disallowed methods", async () => {
  for (const event of ["%2Fsecret", "%252Fsecret", "%ZZ", "a%3Fb", "a%23b"]) {
    assert.equal(
      (await call(`/teams/${team}/overview/${event}/clear`)).status,
      404
    );
  }
  const request = Object.assign(Readable.from([]), {
    method: "POST",
    headers: {}
  });
  assert.equal((await call("/teams/overview", { request })).status, 405);
});

test("authority access failures and stale revisions remain visible to clients", async () => {
  for (const status of [401, 403, 409]) {
    assert.equal(
      (
        await call("/teams/overview", {
          fetchImpl: async () => Response.json({ error: "denied" }, { status })
        })
      ).status,
      status
    );
  }
  assert.equal(
    (
      await call("/teams/overview", {
        resolveAccess: async () => {
          throw new Error("offline");
        },
        fetchImpl: () => assert.fail("offline cannot fetch")
      })
    ).status,
    503
  );
});
