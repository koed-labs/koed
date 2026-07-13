import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { parseBootstrapArgs, runCodexBootstrap } from "./codex-bootstrap.mjs";

test("codex bootstrap args respect env defaults and flags", () => {
  const args = parseBootstrapArgs(["--skip-build", "--name=Codex"], {
    MEMORY_NODE_COMMAND: "/opt/node"
  });

  assert.deepEqual(args, {
    ownerEmail: "local@koed.ai",
    name: "Codex",
    apiUrl: "http://localhost:3300",
    nodeCommand: "/opt/node",
    skipBuild: true,
    skipVerify: false,
    skipDoctor: false,
    help: false
  });
});

test("codex bootstrap runs the setup flow in order", async () => {
  const calls = [];
  const environment = {
    MEMORY_API_URL: "http://127.0.0.1:3300",
    MEMORY_NODE_COMMAND: "node",
    MEMORY_CODEX_APP_SERVER_BINARY: "codex",
    KOED_PROMPT_DIR: "/opt/koed/prompts",
    CODEX_CONFIG_PATH: "/tmp/koed-config.toml",
    MEMORY_HOOK_CONFIG: "/tmp/koed-hook.json"
  };
  const tokenResult = {
    ownerCreated: true,
    owner: { email: "local@koed.ai" },
    apiToken: { id: "api-token-id", tokenPrefix: "cmt_test" },
    token: "cmt_test_token"
  };

  const result = await runCodexBootstrap({
    argv: [
      "--owner-email",
      "local@koed.ai",
      "--name",
      "Codex",
      "--api-url",
      "http://127.0.0.1:3300",
      "--node-command",
      "node"
    ],
    environment,
    repo: { close() {} },
    loadRootEnvFn: () => {
      calls.push(["load-root-env"]);
    },
    createTokenBootstrap: async ({ argv, environment: tokenEnvironment }) => {
      calls.push(["create-token", argv, tokenEnvironment]);
      return tokenResult;
    },
    runCommandFn: async ({
      label,
      command,
      args,
      env = {},
      captureOutput = false
    }) => {
      calls.push([label, command, args, env, captureOutput]);
      if (captureOutput) {
        return {
          stdout: JSON.stringify({
            ok: true,
            apiUrl: "http://127.0.0.1:3300",
            tools: ["memory_answer"]
          }),
          stderr: ""
        };
      }

      return { stdout: "", stderr: "" };
    },
    onTokenCreated: (createdTokenResult) => {
      calls.push(["token-output", createdTokenResult.token]);
    },
    onComplete: (summary) => {
      calls.push(["complete", summary]);
    }
  });

  assert.equal(result.help, false);
  assert.deepEqual(result.paths, {
    codexConfigPath: "/tmp/koed-config.toml",
    hookConfigPath: "/tmp/koed-hook.json"
  });
  assert.equal(result.tokenResult, tokenResult);
  assert.equal(result.doctorResult?.ok, true);

  assert.deepEqual(
    calls.map(([first]) => first),
    [
      "Prepare local environment",
      "load-root-env",
      "Build @koed/db",
      "Build @koed/mcp-server",
      "create-token",
      "token-output",
      "Configure Codex",
      "Verify capture",
      "Run doctor",
      "complete"
    ]
  );

  const configureCall = calls.find(([label]) => label === "Configure Codex");
  assert.ok(configureCall);
  assert.deepEqual(configureCall[3], {
    MEMORY_API_URL: "http://127.0.0.1:3300",
    MEMORY_API_TOKEN: "cmt_test_token",
    MEMORY_NODE_COMMAND: "node",
    MEMORY_CODEX_APP_SERVER_BINARY: "codex",
    KOED_PROMPT_DIR: "/opt/koed/prompts"
  });

  const verifyCall = calls.find(([label]) => label === "Verify capture");
  assert.ok(verifyCall);
  assert.deepEqual(verifyCall[3], {
    MEMORY_API_URL: "http://127.0.0.1:3300",
    MEMORY_API_TOKEN: "cmt_test_token",
    MEMORY_NODE_COMMAND: "node"
  });

  const doctorCall = calls.find(([label]) => label === "Run doctor");
  assert.ok(doctorCall);
  assert.equal(doctorCall[4], true);
  assert.deepEqual(doctorCall[3], {
    MEMORY_API_URL: "http://127.0.0.1:3300",
    MEMORY_API_TOKEN: "cmt_test_token",
    MEMORY_CODEX_APP_SERVER_BINARY: "codex",
    KOED_PROMPT_DIR: "/opt/koed/prompts"
  });
});

test("codex bootstrap loads root env before resolving defaults", async () => {
  const calls = [];
  const environment = {
    CODEX_CONFIG_PATH: "/tmp/koed-config.toml",
    MEMORY_HOOK_CONFIG: "/tmp/koed-hook.json"
  };
  const tokenResult = {
    ownerCreated: false,
    owner: { email: "local@koed.ai" },
    apiToken: { id: "api-token-id", tokenPrefix: "cmt_env" },
    token: "cmt_env_token"
  };

  const result = await runCodexBootstrap({
    argv: ["--skip-build", "--skip-verify", "--skip-doctor"],
    environment,
    repo: { close() {} },
    loadRootEnvFn: (_rootDir, env) => {
      calls.push(["load-root-env"]);
      env.MEMORY_API_URL = "http://127.0.0.1:3300";
      env.MEMORY_NODE_COMMAND = "/opt/node";
      env.MEMORY_CODEX_APP_SERVER_BINARY = "/opt/codex";
      env.KOED_PROMPT_DIR = "custom-prompts";
    },
    createTokenBootstrap: async () => tokenResult,
    runCommandFn: async ({ label, env = {} }) => {
      calls.push([label, env]);
      return { stdout: "", stderr: "" };
    },
    onTokenCreated: () => {},
    onComplete: () => {}
  });

  assert.equal(result.args.apiUrl, "http://127.0.0.1:3300");
  assert.equal(result.args.nodeCommand, "/opt/node");

  const configureCall = calls.find(([label]) => label === "Configure Codex");
  assert.ok(configureCall);
  assert.deepEqual(configureCall[1], {
    MEMORY_API_URL: "http://127.0.0.1:3300",
    MEMORY_API_TOKEN: "cmt_env_token",
    MEMORY_NODE_COMMAND: "/opt/node",
    MEMORY_CODEX_APP_SERVER_BINARY: "/opt/codex",
    KOED_PROMPT_DIR: path.resolve("custom-prompts")
  });
});
