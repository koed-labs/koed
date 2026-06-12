import assert from "node:assert/strict";
import { test } from "node:test";
import { runClientsBootstrap } from "./clients-bootstrap.mjs";

test("clients bootstrap chains environment, codex, and explorer setup", async () => {
  const calls = [];
  const result = await runClientsBootstrap({
    rootDir: "/tmp/koed",
    runCommandFn: async ({ label, command, args, cwd }) => {
      calls.push([label, command, args, cwd]);
    },
    runCodexBootstrapFn: async ({ skipSetup }) => {
      calls.push(["codex-bootstrap", skipSetup]);
      return {
        args: { skipVerify: false, skipDoctor: false },
        tokenResult: { owner: { email: "local@koed.ai" }, token: "cmt_token" }
      };
    },
    runExplorerBootstrapFn: async ({ token, rootDir }) => {
      calls.push(["explorer-bootstrap", token, rootDir]);
      return {
        paths: { explorerEnvPath: "/tmp/koed/apps/explorer/.env.local" }
      };
    },
    onComplete: (summary) => {
      calls.push(["complete", summary]);
    }
  });

  assert.deepEqual(result.codex.tokenResult.token, "cmt_token");
  assert.deepEqual(
    calls.map(([first]) => first),
    [
      "Prepare local environment",
      "Start Koed backend services",
      "codex-bootstrap",
      "explorer-bootstrap",
      "complete"
    ]
  );
  assert.equal(calls[2][1], true);
  assert.equal(calls[3][1], "cmt_token");
});
