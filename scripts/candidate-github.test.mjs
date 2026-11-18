import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { candidateGithub } from "./candidate-github.mjs";

test("reads only canonical repository endpoints with an authenticated GitHub request", async () => {
  const requests = [];
  const client = candidateGithub("private-token", async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ value: 1 }), { status: 200 });
  });
  assert.deepEqual(await client.api("/repos/koed-labs/koed/pulls/537"), {
    value: 1
  });
  assert.equal(
    requests[0].options.headers.Authorization,
    "Bearer private-token"
  );
  await assert.rejects(client.api("/repos/other/repo/pulls/1"));
});

test("downloads a bounded artifact without forwarding the token to blob storage", async (t) => {
  const base = resolve("scratch", "candidate-github-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const client = candidateGithub("private-token", async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1)
      return new Response(null, {
        status: 302,
        headers: { location: "https://example.com/artifact?private=1" }
      });
    return new Response("payload", { status: 200 });
  });
  const output = join(root, "artifact.zip");
  await client.downloadArtifact(123, output, 100);
  assert.equal(readFileSync(output, "utf8"), "payload");
  assert.equal(
    requests[0].options.headers.Authorization,
    "Bearer private-token"
  );
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.equal(requests[1].options.redirect, "error");
});

test("rejects non-HTTPS redirect targets and download overflow", async (t) => {
  const base = resolve("scratch", "candidate-github-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unsafe = candidateGithub(
    "token",
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://example.com/" }
      })
  );
  await assert.rejects(unsafe.downloadArtifact(123, join(root, "unsafe"), 100));
  let count = 0;
  const large = candidateGithub("token", async () =>
    ++count === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://example.com/" }
        })
      : new Response("too large")
  );
  await assert.rejects(large.downloadArtifact(123, join(root, "large"), 2));
});
