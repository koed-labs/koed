import assert from "node:assert/strict";
import { test } from "node:test";
import { runExplorerBootstrap } from "./explorer-bootstrap.mjs";

test("explorer bootstrap writes token config and builds explorer", async () => {
  const calls = [];
  const result = await runExplorerBootstrap({
    argv: ["--token", "cmt_test_token"],
    rootDir: "/tmp/koed",
    writeExplorerTokenConfigFn: ({ rootDir, token }) => {
      calls.push(["write", rootDir, token]);
    },
    runCommandFn: async ({ label, command, args, cwd, environment }) => {
      calls.push([label, command, args, cwd, environment]);
    },
    onComplete: (summary) => {
      calls.push(["complete", summary]);
    }
  });

  assert.equal(result.help, false);
  assert.deepEqual(
    calls.map(([first]) => first),
    ["write", "Build Explorer assets", "complete"]
  );
  assert.deepEqual(calls[0], ["write", "/tmp/koed", "cmt_test_token"]);
  assert.deepEqual(calls[1][1], "pnpm");
  assert.deepEqual(calls[1][2], ["--filter", "@koed/explorer", "build"]);
  assert.equal(calls[1][4].MEMORY_API_TOKEN, "cmt_test_token");
  assert.equal(calls[1][4].VITE_KOED_API_TOKEN, "cmt_test_token");
});
