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

test("preserves the bounded managed Memory recall error contract", async () => {
  const request = Readable.from([Buffer.from('{"prompt":"goal"}')]);
  request.method = "POST";
  request.headers = { "content-type": "application/json" };
  let result;
  await handlePersonalAgents({
    request,
    url: new URL(
      "http://localhost/studio-api/managed-conversations/11111111-1111-4111-8111-111111111111/prompts"
    ),
    validCsrf: () => true,
    resolveToken: async () => "secret",
    apiBase: "http://127.0.0.1:43300",
    routeFamily: "managed-conversations",
    fetchImpl: async () =>
      Response.json(
        {
          error: {
            code: "MEMORY_RECALL_UNAVAILABLE",
            message:
              "Memory could not be checked. Retry or continue without Memory."
          }
        },
        { status: 503 }
      ),
    send: (status, body) => {
      result = { status, body };
    }
  });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, {
    error: {
      code: "MEMORY_RECALL_UNAVAILABLE",
      message: "Memory could not be checked. Retry or continue without Memory."
    }
  });
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

test("maps only the bounded Agent name conflict without leaking backend details", async () => {
  const named = await call({
    fetchImpl: async () =>
      Response.json(
        { code: "name_conflict", error: "private details" },
        { status: 409 }
      )
  });
  assert.equal(named.status, 409);
  assert.equal(named.body.code, "name_conflict");
  assert.match(named.body.error, /Choose another name/);
  assert.equal(JSON.stringify(named).includes("private details"), false);
  const other = await call({
    fetchImpl: async () =>
      Response.json(
        { code: "stale_version", error: "private details" },
        { status: 409 }
      )
  });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, undefined);
});

test("uses paired local access for each route family and never falls back after readiness failure", async () => {
  const cases = [
    ["personal-agents", "/studio-api/personal-agents"],
    [
      "personal-agent-role-templates",
      "/studio-api/personal-agent-role-templates"
    ],
    ["managed-conversations", "/studio-api/managed-conversations"]
  ];
  for (const [routeFamily, pathname] of cases) {
    const request = Readable.from([]);
    request.method = "GET";
    request.headers = {};
    const result = await call({
      request,
      routeFamily,
      url: new URL(`http://localhost${pathname}`),
      resolveAccess: async () => ({
        apiOrigin: "http://127.0.0.1:59451",
        apiToken: "paired-secret"
      }),
      fetchImpl: async (url, init) => {
        assert.equal(new URL(url).origin, "http://127.0.0.1:59451");
        assert.equal(init.headers.authorization, "Bearer paired-secret");
        return Response.json({ agents: [], templates: [], executions: [] });
      }
    });
    assert.equal(result.status, 200, routeFamily);
  }

  for (const access of [
    async () => {
      throw new Error("not_ready");
    },
    async () => ({
      apiOrigin: "https://example.invalid",
      apiToken: "must-not-be-sent"
    })
  ]) {
    for (const [routeFamily, pathname] of cases) {
      const request = Readable.from([]);
      request.method = "GET";
      request.headers = {};
      const result = await call({
        request,
        routeFamily,
        url: new URL(`http://localhost${pathname}`),
        resolveAccess: access,
        fetchImpl: () => assert.fail("must not contact any API origin")
      });
      assert.equal(result.status, 503, routeFamily);
      assert.equal(JSON.stringify(result).includes("must-not-be-sent"), false);
    }
  }
});

test("forwards only an authenticated, CSRF-checked Agent restore", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const path = `http://localhost/studio-api/personal-agents/${id}/restore`;
  const payload = {
    requestId: "22222222-2222-4222-8222-222222222222",
    expectedVersion: 2
  };
  const makeRequest = (method) => {
    const request = Readable.from([Buffer.from(JSON.stringify(payload))]);
    request.method = method;
    request.headers = { "content-type": "application/json" };
    return request;
  };
  const result = await call({
    request: makeRequest("POST"),
    url: new URL(path),
    fetchImpl: async (url, init) => {
      assert.equal(url.pathname, `/v1/personal-agents/${id}/restore`);
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, "Bearer secret");
      assert.deepEqual(JSON.parse(init.body), payload);
      return Response.json({ agent: { id, lifecycle: "active" } });
    }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.agent.id, id);
  assert.equal(
    (
      await call({
        request: makeRequest("GET"),
        url: new URL(path),
        fetchImpl: () => assert.fail("restore must be POST only")
      })
    ).status,
    405
  );
  assert.equal(
    (
      await call({
        request: makeRequest("POST"),
        url: new URL(path),
        validCsrf: () => false,
        fetchImpl: () => assert.fail("restore requires CSRF")
      })
    ).status,
    403
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
  const commandId = "22222222-2222-4222-8222-222222222222";
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
  const cancelRequest = Readable.from([
    Buffer.from('{"executionGeneration":1}')
  ]);
  cancelRequest.method = "POST";
  cancelRequest.headers = { "content-type": "application/json" };
  const canceled = await call({
    request: cancelRequest,
    routeFamily: "managed-conversations",
    url: new URL(`${base}/${id}/prompts/${commandId}/cancel`),
    fetchImpl: async (url, init) => {
      assert.equal(
        url.pathname,
        `/v1/managed-conversations/${id}/prompts/${commandId}/cancel`
      );
      assert.equal(init.method, "POST");
      assert.equal(init.body, '{"executionGeneration":1}');
      assert.equal(init.headers.authorization, "Bearer secret");
      return Response.json({
        command: { id: commandId, state: "canceled", canceled: true }
      });
    }
  });
  assert.equal(canceled.status, 200);
  const csrfRequest = Readable.from([Buffer.from('{"executionGeneration":1}')]);
  csrfRequest.method = "POST";
  csrfRequest.headers = { "content-type": "application/json" };
  assert.equal(
    (
      await call({
        request: csrfRequest,
        routeFamily: "managed-conversations",
        url: new URL(`${base}/${id}/prompts/${commandId}/cancel`),
        validCsrf: () => false,
        fetchImpl: () => assert.fail("CSRF must be required before cancel")
      })
    ).status,
    403
  );
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

test("managed recovery lookup forwards only exact read-only identities", async () => {
  const base =
    "http://localhost/studio-api/managed-conversations/recovery/lookup";
  const key = "send-key";
  const id = "11111111-1111-4111-8111-111111111111";
  const messageId = "22222222-2222-4222-8222-222222222222";
  const query = `kind=prompt&idempotencyKey=${key}&clientUserMessageId=${messageId}&executionId=${id}&executionGeneration=1`;
  const request = Readable.from([]);
  request.method = "GET";
  request.headers = {};
  const result = await call({
    request,
    routeFamily: "managed-conversations",
    url: new URL(`${base}?${query}`),
    fetchImpl: async (url, init) => {
      assert.equal(url.pathname, "/v1/managed-conversations/recovery/lookup");
      assert.equal(url.search.slice(1), query);
      assert.equal(init.method, "GET");
      assert.equal(init.headers.authorization, "Bearer secret");
      return Response.json({ found: false });
    }
  });
  assert.equal(result.status, 200);
  const invalid = await call({
    request,
    routeFamily: "managed-conversations",
    url: new URL(`${base}?${query}&ownerId=another`),
    fetchImpl: () => assert.fail("invalid lookup must not reach API")
  });
  assert.equal(invalid.status, 400);
  const write = Readable.from([Buffer.from("{}")]);
  write.method = "POST";
  write.headers = { "content-type": "application/json" };
  assert.equal(
    (
      await call({
        request: write,
        routeFamily: "managed-conversations",
        url: new URL(`${base}?kind=start&idempotencyKey=${key}`),
        fetchImpl: () => assert.fail("lookup must be read only")
      })
    ).status,
    405
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
    request.headers =
      method === "GET" ? {} : { "content-type": "application/json" };
    const result = await call({
      request,
      routeFamily: "managed-conversations",
      url: new URL(base + suffix),
      fetchImpl: async (url, init) => {
        assert.equal(
          url.pathname,
          `/v1/managed-conversations/${id}/project-moves${suffix}`
        );
        assert.equal(init.method, method);
        assert.equal(init.headers.authorization, "Bearer secret");
        return Response.json(
          { move: null },
          { status: method === "GET" ? 200 : 202 }
        );
      }
    });
    assert.equal(result.status, method === "GET" ? 200 : 202);
  }
});
