import assert from "node:assert/strict";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from "@modelcontextprotocol/server";

const origin = `http://127.0.0.1:${process.env.KOED_AUTH_PROTOTYPE_PORT ?? "43555"}`;
const status = (await fetch(origin).then((response) => response.json())) as {
  mode: string;
};
assert.equal(
  status.mode,
  "local-fixture",
  "This smoke simulates a User and must never run against live WorkOS"
);
const post = (path: string, body?: unknown, token?: string) =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
const document = await fetch(`${origin}/auth.md`);
assert.equal(document.status, 200);
assert.match(await document.text(), /synthetic local fixture/);
const registration = await post("/fixture/register", { type: "service_auth" });
assert.equal(registration.status, 200);
const claim = (await registration.json()) as {
  claim_token: string;
  verification_uri: string;
};
const path = new URL(claim.verification_uri).pathname;
const preapproval = await post("/fixture/complete", {
  claim_token: claim.claim_token,
  user_code: "000000"
});
assert.equal(preapproval.status, 403);
// Simulate the User only in this explicit synthetic-fixture smoke.
const approved = await post(`${path}/approve`);
assert.equal(approved.status, 200);
const code = (await approved.text()).match(/<code>(\d{6})<\/code>/)?.[1];
assert.ok(code);
const exchanged = await post("/fixture/complete", {
  claim_token: claim.claim_token,
  user_code: code
});
assert.equal(exchanged.status, 200);
const { access_token: token } = (await exchanged.json()) as {
  access_token: string;
};
const call = async () =>
  fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "memory_access_check"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "memory_access_check",
        arguments: {},
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
          [CLIENT_INFO_META_KEY]: { name: "auth-smoke", version: "1" },
          [CLIENT_CAPABILITIES_META_KEY]: {}
        }
      }
    })
  });
const access = await call();
assert.equal(access.status, 200);
assert.match(await access.text(), /synthetic-only/);
assert.equal((await post("/v1/sessions", {}, token)).status, 403);
assert.equal(
  (await post("/v1/memory/answer-tasks/claim", {}, token)).status,
  403
);
assert.equal(
  (await post("/v1/team-workspaces/prototype/members", {}, token)).status,
  403
);
assert.equal((await post("/fixture/revoke", undefined, token)).status, 200);
assert.equal((await call()).status, 401);
console.log(
  JSON.stringify({
    result: "passed",
    transport: "real-loopback-http",
    provider: "synthetic-workos-contract",
    confirmationRequired: true,
    mcpAccess: true,
    separateScopesEnforced: true,
    revocationEnforced: true,
    liveWorkosTested: false
  })
);
