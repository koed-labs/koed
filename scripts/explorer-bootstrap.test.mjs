import assert from "node:assert/strict";
import { test } from "node:test";
import { runExplorerBootstrap } from "./explorer-bootstrap.mjs";

test("explorer bootstrap writes token config and refreshes explorer", async () => {
  const calls = [];
  const result = await runExplorerBootstrap({
    argv: ["--token", "cmt_test_token"],
    rootDir: "/tmp/koed",
    writeExplorerTokenConfigFn: ({ rootDir, token }) => {
      calls.push(["write", rootDir, token]);
    },
    runCommandFn: async ({ label, command, args, cwd }) => {
      calls.push([label, command, args, cwd]);
    },
    onComplete: (summary) => {
      calls.push(["complete", summary]);
    }
  });

  assert.equal(result.help, false);
  assert.deepEqual(
    calls.map(([first]) => first),
    ["write", "Refresh Explorer Docker image", "complete"]
  );
  assert.deepEqual(calls[0], ["write", "/tmp/koed", "cmt_test_token"]);
  assert.deepEqual(calls[1][2], ["compose", "up", "-d", "--build", "explorer"]);
});
