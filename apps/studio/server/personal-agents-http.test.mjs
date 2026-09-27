import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  handlePersonalAgents,
  handlePersonalAgentRoleTemplates
} from "./personal-agents-http.mjs";

async function call(overrides = {}) {
  let result;
  const request = Readable.from([Buffer.from('{"name":"Bob"}')]);
  request.method = "POST";
  request.headers = { "content-type": "application/json" };
  await handlePersonalAgents({
    request,
    url: new URL("http://localhost/studio-api/personal-agents"),
    validCsrf: () => true,
    resolveToken: async () => "secret",
    apiBase: "http://127.0.0.1:43300",
    fetchImpl: async () => Response.json({ agents: [] }),
    ...overrides,
    send: (status, body) => {
      result = { status, body };
    }
  });
  return result;
}
test("agent writes require CSRF before contacting the backend", async () => {
  assert.equal(
    (
      await call({
        validCsrf: () => false,
        fetchImpl: () => assert.fail("must not fetch")
      })
    ).status,
    403
  );
});
test("agent proxy forwards only to local owner-authenticated API", async () => {
  const result = await call({
    fetchImpl: async (url, init) => {
      assert.equal(url.href, "http://127.0.0.1:43300/v1/personal-agents");
      assert.equal(init.headers.authorization, "Bearer secret");
      assert.equal(init.redirect, "error");
      assert.equal(init.body, '{"name":"Bob"}');
      return Response.json({ agent: { name: "Bob" } }, { status: 201 });
    }
  });
  assert.equal(result.status, 201);
});
test("rejects non-local upstream and missing credential", async () => {
  assert.equal((await call({ apiBase: "https://evil.example" })).status, 503);
  assert.equal((await call({ resolveToken: async () => null })).status, 401);
});
test("rejects unknown paths and query overrides", async () => {
  assert.equal(
    (
      await call({
        url: new URL("http://localhost/studio-api/personal-agents/other")
      })
    ).status,
    404
  );
  assert.equal(
    (
      await call({
        url: new URL(
          "http://localhost/studio-api/personal-agents?owner=another"
        )
      })
    ).status,
    400
  );
});
test("does not expose backend error details", async () => {
  const result = await call({
    fetchImpl: async () => new Response("secret stack trace", { status: 500 })
  });
  assert.equal(result.status, 503);
  assert.ok(!JSON.stringify(result).includes("secret"));
});
test("preserves conflict status so stale edits cannot masquerade as saved", async () => {
  assert.equal(
    (
      await call({
        fetchImpl: async () => new Response("conflict", { status: 409 })
      })
    ).status,
    409
  );
});

test("role template catalogue is a read-only authenticated API proxy", async () => {
  let result;
  const request = Readable.from([]);
  request.method = "GET";
  request.headers = {};
  await handlePersonalAgentRoleTemplates({
    request,
    url: new URL("http://localhost/studio-api/personal-agent-role-templates"),
    validCsrf: () => true,
    resolveToken: async () => "secret",
    apiBase: "http://127.0.0.1:43300",
    fetchImpl: async (url, init) => {
      assert.equal(
        url.href,
        "http://127.0.0.1:43300/v1/personal-agent-role-templates"
      );
      assert.equal(init.method, "GET");
      assert.equal(init.headers.authorization, "Bearer secret");
      return Response.json({ templates: [] });
    },
    send: (status, body) => {
      result = { status, body };
    }
  });
  assert.equal(result.status, 200);
});

test("rejects oversized bodies before sending secrets upstream", async () => {
  const request = Readable.from([Buffer.alloc(256 * 1024 + 1)]);
  request.method = "POST";
  request.headers = { "content-type": "application/json" };
  assert.equal(
    (await call({ request, fetchImpl: () => assert.fail("must not fetch") }))
      .status,
    413
  );
});

test("caps upstream response size", async () => {
  assert.equal(
    (
      await call({
        fetchImpl: async () => new Response("x".repeat(4 * 1024 * 1024 + 1))
      })
    ).status,
    503
  );
});

test("managed transport allows only scoped conversation actions", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const base = "http://localhost/studio-api/managed-conversations";
  const result = await call({
    routeFamily: "managed-conversations",
    url: new URL(`${base}/${id}/prompts`),
    fetchImpl: async (url, init) => {
      assert.equal(url.pathname, `/v1/managed-conversations/${id}/prompts`);
      assert.equal(init.headers.authorization, "Bearer secret");
      return Response.json({ command: { id } }, { status: 202 });
    }
  });
  assert.equal(result.status, 202);
  for (const path of ["/runner/commands", `/${id}/terminals`, `/${id}/files`]) {
    assert.equal(
      (
        await call({
          routeFamily: "managed-conversations",
          url: new URL(base + path),
          fetchImpl: () => assert.fail("unsupported action must not reach API")
        })
      ).status,
      404
    );
  }
  assert.equal(
    (
      await call({
        routeFamily: "managed-conversations",
        url: new URL(base),
        validCsrf: () => false,
        fetchImpl: () => assert.fail("CSRF must be required")
      })
    ).status,
    403
  );
});

test("managed transport forwards scoped Project Move status and cancellation", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const moveId = "22222222-2222-4222-8222-222222222222";
  const base = `http://localhost/studio-api/managed-conversations/${id}/project-moves`;
  for (const [suffix, method] of [
    ["", "POST"],
    ["/latest", "GET"],
    [`/${moveId}/cancel`, "POST"]
  ]) {
    const request = Readable.from(method === "GET" ? [] : [Buffer.from("{}")]);
    request.method = method;
    request.headers = method === "GET" ? {} : { "content-type": "application/json" };
    const result = await call({
      request,
      routeFamily: "managed-conversations",
      url: new URL(base + suffix),
      fetchImpl: async (url, init) => {
        assert.equal(url.pathname, `/v1/managed-conversations/${id}/project-moves${suffix}`);
        assert.equal(init.method, method);
        assert.equal(init.headers.authorization, "Bearer secret");
        return Response.json({ move: null }, { status: method === "GET" ? 200 : 202 });
      }
    });
    assert.equal(result.status, method === "GET" ? 200 : 202);
  }
});
