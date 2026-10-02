import { test } from "node:test";
import assert from "node:assert/strict";
import { createGithubConnector } from "./github.mjs";

const pr = {
  number: 1,
  title: "Example",
  state: "open",
  user: { login: "alice" },
  head: { sha: "a".repeat(40), ref: "topic" },
  base: { sha: "b".repeat(40), ref: "main" },
  updated_at: "2026-09-22T00:00:00Z",
  html_url: "https://github.com/example/repo/pull/1",
  body: "Untrusted text",
  additions: 1,
  deletions: 0,
  changed_files: 31
};
const accountStatus = {
  hosts: { "github.com": [{ login: "alice", active: true, state: "success" }] }
};
const delegatedFixture = (api) =>
  createGithubConnector({
    execFile: async (_file, args) => {
      if (args[0] === "auth" && args[1] === "status")
        return { stdout: JSON.stringify(accountStatus) };
      if (args[0] === "api" && args[3] === "user")
        return { stdout: JSON.stringify({ id: 123, login: "alice" }) };
      if (args[0] === "api")
        return { stdout: JSON.stringify(await api(args[3])) };
      throw new Error("unexpected gh command");
    }
  });

test("PR context is bounded and flags omitted files and patches", async () => {
  const connector = delegatedFixture(async (url) => {
    if (url.includes("/files?"))
      return Array.from({ length: 30 }, (_, i) => ({
        filename: `file-${i}.ts`,
        status: "modified",
        patch: "x".repeat(20000),
        additions: 1,
        deletions: 0
      }));
    return pr;
  });
  await connector.connect();
  const result = await connector.readPullRequestContext({
    repo: "example/repo",
    number: 1
  });
  assert.equal(result.files.length, 30);
  assert.equal(result.filesTruncated, true);
  assert.equal(result.files[0].patchTruncated, true);
  assert.ok(result.files.reduce((n, f) => n + f.patch.length, 0) <= 96 * 1024);
});

test("PR context refuses a changed head during patch retrieval", async () => {
  let reads = 0;
  const connector = delegatedFixture(async (url) => {
    if (url.includes("/files?")) return [];
    reads++;
    return {
      ...pr,
      head: { ...pr.head, sha: (reads > 1 ? "c" : "a").repeat(40) }
    };
  });
  await connector.connect();
  await assert.rejects(
    connector.readPullRequestContext({ repo: "example/repo", number: 1 }),
    /github_context_changed/
  );
});
