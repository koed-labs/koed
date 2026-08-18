import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  parseBootstrapArgs,
  persistMemoryGuidancePreference,
  runCodexBootstrap
} from "./codex-bootstrap.mjs";

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
    memoryGuidanceEnabled: true,
    help: false
  });
});

test("codex bootstrap runs the setup flow in order", async () => {
  const calls = [];
  const environment = {
    MEMORY_API_URL: "http://127.0.0.1:3300",
    MEMORY_NODE_COMMAND: "node",
    KOED_HOME: "/tmp/koed-home",
    CODEX_CONFIG_PATH: "/tmp/koed-config.toml",
    KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED: "true"
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
    codexInstructionsPath: "/tmp/AGENTS.md"
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
    KOED_HOME: "/tmp/koed-home",
    CODEX_CONFIG_PATH: "/tmp/koed-config.toml",
    KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED: "true"
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
    MEMORY_API_TOKEN: "cmt_test_token"
  });
});

test("codex bootstrap loads root env before resolving defaults", async () => {
  const calls = [];
  const environment = {
    CODEX_CONFIG_PATH: "/tmp/koed-config.toml"
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
      env.KOED_HOME = "/tmp/loaded-koed-home";
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
    KOED_HOME: "/tmp/loaded-koed-home",
    CODEX_CONFIG_PATH: "/tmp/koed-config.toml",
    KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED: "true"
  });
});

test("codex bootstrap supports opting out of global memory guidance", () => {
  const args = parseBootstrapArgs(["--without-memory-guidance"], {});
  assert.equal(args.memoryGuidanceEnabled, false);
});

test("codex bootstrap persists an explicit memory guidance preference", () => {
  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-bootstrap-guidance-"));
  try {
    persistMemoryGuidancePreference({ KOED_HOME: koedHome }, false);
    assert.deepEqual(
      JSON.parse(readFileSync(resolve(koedHome, "config/server.json"), "utf8")),
      { codexGlobalMemoryGuidanceEnabled: false }
    );
  } finally {
    rmSync(koedHome, { recursive: true, force: true });
  }
});

test("codex bootstrap wires the explicit guidance choice into persisted config", async () => {
  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-bootstrap-guidance-"));
  try {
    await runCodexBootstrap({
      argv: [
        "--without-memory-guidance",
        "--skip-build",
        "--skip-verify",
        "--skip-doctor"
      ],
      environment: { KOED_HOME: koedHome },
      repo: { close() {} },
      loadRootEnvFn: () => {},
      createTokenBootstrap: async () => ({
        owner: { email: "local@koed.ai" },
        token: "test-token"
      }),
      runCommandFn: async () => ({ stdout: "", stderr: "" }),
      skipSetup: true,
      onTokenCreated: () => {},
      onComplete: () => {}
    });
    assert.deepEqual(
      JSON.parse(readFileSync(resolve(koedHome, "config/server.json"), "utf8")),
      { codexGlobalMemoryGuidanceEnabled: false }
    );
  } finally {
    rmSync(koedHome, { recursive: true, force: true });
  }
});

test("codex bootstrap rejects malformed persisted server configuration", () => {
  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-bootstrap-guidance-"));
  try {
    const configPath = resolve(koedHome, "config/server.json");
    mkdirSync(resolve(koedHome, "config"), { recursive: true });
    writeFileSync(configPath, "{");
    assert.throws(
      () => persistMemoryGuidancePreference({ KOED_HOME: koedHome }, false),
      /server\.json is malformed/
    );
  } finally {
    rmSync(koedHome, { recursive: true, force: true });
  }
});
