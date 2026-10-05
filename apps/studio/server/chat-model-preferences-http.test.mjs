import { URL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { handleChatModelPreferences } from "./chat-model-preferences-http.mjs";

test("defaults survive a new gateway instance and only persist validated settings", async () => {
  const koedHome = await mkdtemp(path.join(os.tmpdir(), "koed-chat-defaults-"));
  async function call(method, body, valid = true) {
    let result;
    const request = Readable.from(
      body === undefined ? [] : [JSON.stringify(body)]
    );
    request.method = method;
    request.headers = { "content-type": "application/json" };
    assert.equal(
      await handleChatModelPreferences({
        request,
        url: new URL("http://localhost/studio-api/chat-model-preferences"),
        validCsrf: () => valid,
        koedHome,
        send: (status, payload) => {
          result = { status, payload };
        }
      }),
      true
    );
    return result;
  }
  try {
    assert.deepEqual((await call("GET")).payload, { preference: null });
    const preference = { modelKey: "codex:gpt-6.1-sol:device", effort: "high" };
    assert.equal((await call("PUT", preference, false)).status, 403);
    assert.equal(
      (await call("PUT", { modelKey: 3, effort: "high" })).status,
      400
    );
    assert.equal(
      (await call("PUT", { ...preference, modelKey: "x".repeat(2000) })).status,
      413
    );
    assert.equal(
      (await call("PUT", { ...preference, prompt: "never save this" })).status,
      200
    );
    assert.deepEqual((await call("GET")).payload, { preference });
  } finally {
    await rm(koedHome, { recursive: true, force: true });
  }
});
