import assert from "node:assert/strict";
import { test } from "node:test";
import { runClientsBootstrap } from "./clients-bootstrap.mjs";

test("clients bootstrap chains environment, dependencies, codex, and explorer setup", async () => {
  const calls = [];
  const result = await runClientsBootstrap({
    environment: { API_HOST_PORT: "4545" },
    rootDir: "/tmp/koed",
    runCommandFn: async ({ label, command, args, cwd }) => {
      calls.push([label, command, args, cwd]);
    },
    waitForApiReadyFn: async ({ apiUrl }) => {
      calls.push(["api-ready", apiUrl]);
    },
    runCodexBootstrapFn: async ({ skipSetup, argv }) => {
      calls.push(["codex-bootstrap", skipSetup, argv]);
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
      "Start Koed dependency containers",
      "api-ready",
      "codex-bootstrap",
      "explorer-bootstrap",
      "complete"
    ]
  );
  assert.equal(calls[2][1], "http://localhost:4545");
  assert.equal(calls[3][1], true);
  assert.deepEqual(calls[3][2], []);
  assert.equal(calls[4][1], "cmt_token");
});

test("clients bootstrap can rely on koed-server managed dependencies", async () => {
  const calls = [];
  await runClientsBootstrap({
    environment: { API_HOST_PORT: "4545", KOED_SERVER_MANAGED: "1" },
    rootDir: "/tmp/koed",
    runCommandFn: async ({ label, command, args, cwd }) => {
      calls.push([label, command, args, cwd]);
    },
    waitForApiReadyFn: async ({ apiUrl }) => {
      calls.push(["api-ready", apiUrl]);
    },
    runCodexBootstrapFn: async ({ skipSetup, argv }) => {
      calls.push(["codex-bootstrap", skipSetup, argv]);
      return {
        args: { skipVerify: true, skipDoctor: true },
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

  assert.deepEqual(
    calls.map(([first]) => first),
    [
      "Prepare local environment",
      "api-ready",
      "codex-bootstrap",
      "explorer-bootstrap",
      "complete"
    ]
  );
  assert.deepEqual(calls[2][2], ["--skip-verify", "--skip-doctor"]);
});
