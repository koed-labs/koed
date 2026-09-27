import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handlePrChat } from "./pr-chat-http.mjs";

const valid = {
  repo: "example/repo",
  number: 1,
  headSha: "a".repeat(40),
  text: "Explain this PR",
  requestId: "request_123"
};
async function call({
  method = "POST",
  body = valid,
  csrf = true,
  path = "/studio-api/pr-chat/message",
  runtime = { sendMessage: async () => ({ messages: [] }) }
} = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.headers = { "content-type": "application/json" };
  let result;
  await handlePrChat({
    request,
    url: new URL(path, "http://localhost"),
    runtime,
    validCsrf: () => csrf,
    send: (status, body) => {
      result = { status, body };
    }
  });
  return result;
}
test("Chat writes require CSRF and validated inputs", async () => {
  assert.equal((await call({ csrf: false })).status, 403);
  assert.equal(
    (await call({ body: { ...valid, token: "secret" } })).status,
    400
  );
  assert.equal((await call({ body: { ...valid, text: "" } })).status, 400);
  assert.equal(
    (await call({ body: { ...valid, repo: "example/.." } })).status,
    400
  );
  assert.equal((await call({ method: "GET" })).status, 405);
  assert.equal((await call()).status, 200);
});
test("Chat GET rejects duplicate scope and errors never leak runtime output", async () => {
  assert.equal(
    (
      await call({
        method: "GET",
        path: "/studio-api/pr-chat/conversation?repo=a/b&repo=c/d&number=1&headSha=aaaaaaa"
      })
    ).status,
    400
  );
  const result = await call({
    runtime: {
      sendMessage: async () => {
        throw new Error("secret-provider-output");
      }
    }
  });
  assert.equal(result.status, 503);
  assert.equal(
    JSON.stringify(result).includes("secret-provider-output"),
    false
  );
});

test("Ask-before-run approval routes remain CSRF protected and PR-scoped", async () => {
  const approvalBody = {
    repo: "example/repo",
    number: 1,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    requestId: "request_123",
    approvalId: "command_123",
    decision: "accept"
  };
  let resolved;
  const runtime = {
    getPendingApproval: async (input) => ({
      approvalId: input.requestId,
      title: "Run tests",
      detail: "checkout"
    }),
    respondToApproval: async (input) => {
      resolved = input;
      return { accepted: true };
    }
  };
  const denied = await call({
    body: approvalBody,
    path: "/studio-api/pr-chat/approval/resolve",
    csrf: false,
    runtime
  });
  assert.equal(denied.status, 403);

  const query = new URLSearchParams({
    repo: approvalBody.repo,
    number: "1",
    headSha: approvalBody.headSha,
    baseSha: approvalBody.baseSha,
    requestId: approvalBody.requestId
  });
  const pending = await call({
    method: "GET",
    path: `/studio-api/pr-chat/approval?${query}`,
    runtime
  });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.approvalId, approvalBody.requestId);

  const response = await call({
    body: approvalBody,
    path: "/studio-api/pr-chat/approval/resolve",
    runtime
  });
  assert.equal(response.status, 200);
  assert.equal(resolved.decision, "accept");
  assert.equal(resolved.headSha, approvalBody.headSha);
});
