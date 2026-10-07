import assert from "node:assert/strict";
import { test } from "node:test";
import { runClientsBootstrap } from "./clients-bootstrap.mjs";

test("clients bootstrap chains environment, dependencies, and Codex setup", async () => {
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
      "complete"
    ]
  );
  assert.equal(calls[2][1], "http://localhost:4545");
  assert.equal(calls[3][1], true);
  assert.deepEqual(calls[3][2], []);
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
    onComplete: (summary) => {
      calls.push(["complete", summary]);
    }
  });

  assert.deepEqual(
    calls.map(([first]) => first),
    ["Prepare local environment", "api-ready", "codex-bootstrap", "complete"]
  );
  assert.deepEqual(calls[2][2], ["--skip-verify", "--skip-doctor"]);
});

test("managed bootstrap keeps the explicit isolated API endpoint and core validation", async () => {
  const calls = [];
  const apiUrl = "http://127.0.0.1:53555";
  await runClientsBootstrap({
    environment: {
      API_HOST_PORT: "3300",
      MEMORY_API_URL: apiUrl,
      KOED_SERVER_MANAGED: "1",
      KOED_CORE_TOKEN_VALIDATED: "1"
    },
    rootDir: "/tmp/koed-isolated-bootstrap",
    runCommandFn: async ({ label, command }) => {
      calls.push(label);
      assert.notEqual(command, "docker");
    },
    waitForApiReadyFn: async ({ apiUrl: actual }) => {
      assert.equal(actual, apiUrl);
    },
    runCodexBootstrapFn: async ({ environment, skipSetup, argv }) => {
      assert.equal(environment.MEMORY_API_URL, apiUrl);
      assert.equal(environment.KOED_CORE_TOKEN_VALIDATED, "1");
      assert.equal(skipSetup, true);
      assert.deepEqual(argv, ["--skip-verify", "--skip-doctor"]);
      return {
        args: {},
        tokenResult: { owner: { email: "fixture@example.test" } }
      };
    },
    onComplete: () => {}
  });
  assert.deepEqual(calls, ["Prepare local environment"]);
});
