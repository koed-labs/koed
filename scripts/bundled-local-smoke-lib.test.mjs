import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  buildBundledLocalSmokeEnvironment,
  parseBundledLocalSmokeArgs,
  preflightBundledLocalSmoke,
  runBundledLocalSmoke,
  waitForBundledLocalHealthy
} from "./bundled-local-smoke-lib.mjs";

const success = (stdout = "{}") => ({
  status: 0,
  stdout,
  stderr: "",
  error: undefined
});

const failure = (stderr = "failed") => ({
  status: 1,
  stdout: "",
  stderr,
  error: undefined
});

const createDeps = (overrides = {}) => {
  const calls = [];
  let port = 4100;
  return {
    calls,
    randomUUID: () => "12345678-aaaa-bbbb-cccc-123456789abc",
    getFreePort: async () => {
      port += 1;
      return port;
    },
    mkdtemp: async (prefix) => `${prefix}test`,
    mkdir: async () => undefined,
    rm: async (target) => calls.push({ kind: "rm", target }),
    writeFile: async () => undefined,
    fileExists: () => false,
    setTimeout: async () => undefined,
    now: (() => {
      let value = 0;
      return () => {
        value += 100;
        return value;
      };
    })(),
    spawnSync: (command, args, options) => {
      calls.push({ kind: "spawnSync", command, args, options });
      return success("{}");
    },
    spawn: (command, args, options) => {
      calls.push({ kind: "spawn", command, args, options });
      const child = new EventEmitter();
      child.pid = 42;
      child.exitCode = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal) => {
        calls.push({ kind: "kill", signal });
        child.exitCode = signal === "SIGKILL" ? 137 : 0;
        child.emit("exit", child.exitCode);
        return true;
      };
      return child;
    },
    ...overrides
  };
};

test("parses smoke CLI options", () => {
  assert.deepEqual(
    parseBundledLocalSmokeArgs(["--", "--json", "--timeout-ms", "50"]),
    {
      json: true,
      timeoutMs: 50,
      pollIntervalMs: 2000
    }
  );
  assert.throws(() => parseBundledLocalSmokeArgs(["--wat"]), /Unknown/);
});

test("builds isolated bundled-local environment with unique ports and compose project", async () => {
  const deps = createDeps();
  const context = await buildBundledLocalSmokeEnvironment({
    root: "/repo",
    deps,
    baseEnv: { WORK_QUEUE_BACKEND: "bullmq" }
  });

  assert.match(context.koedHome, /koed-bundled-smoke-home-test$/);
  assert.equal(context.env.KOED_ENV_PATH, `${context.koedHome}/repo.env`);
  assert.equal(context.env.KOED_REPO_ROOT, "/repo");
  assert.equal(context.env.KOED_DEPENDENCY_MODE, "bundled-local");
  assert.equal(context.env.WORK_QUEUE_BACKEND, "bullmq");
  assert.equal(context.composeProject, "koed-smoke-12345678");
  assert.deepEqual(context.expectedServices, [
    "postgres",
    "redis",
    "embedding-service"
  ]);
  assert.equal(new Set(Object.values(context.ports)).size, 5);
});

test("preflight reports missing Docker clearly", () => {
  const deps = createDeps({
    spawnSync: (command, args) =>
      command === "docker" && args[0] === "info"
        ? failure("daemon down")
        : success()
  });

  assert.throws(
    () => preflightBundledLocalSmoke(deps),
    /Docker daemon preflight failed/
  );
});

test("run skips model install when model URL or checksum env is absent", async () => {
  const deps = createDeps({
    spawnSync: (command, args) => {
      deps.calls.push({ kind: "spawnSync", command, args });
      if (args.includes("status")) {
        return success(
          JSON.stringify({
            dependencyMode: "bundled-local",
            api: { state: "healthy" },
            database: { state: "healthy" },
            embeddingService: { state: "healthy" },
            redis: { state: "healthy", details: { backend: "local" } }
          })
        );
      }
      return success("{}");
    }
  });

  const result = await runBundledLocalSmoke({
    root: "/repo",
    deps,
    env: {},
    json: true
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.steps.find((step) => step.step === "embedding-model-install")?.state,
    "skipped"
  );
  assert.equal(
    deps.calls.some(
      (call) => call.kind === "spawnSync" && call.args?.includes("install")
    ),
    false
  );
});

test("run installs and verifies model when model env is present", async () => {
  const deps = createDeps({
    spawnSync: (command, args) => {
      deps.calls.push({ kind: "spawnSync", command, args });
      if (args.includes("install"))
        return success(JSON.stringify({ ok: true }));
      if (args.includes("models") && args.includes("status")) {
        return success(
          JSON.stringify({ state: "installed", modelPath: "/tmp/model.gguf" })
        );
      }
      if (args.includes("status")) {
        return success(
          JSON.stringify({
            dependencyMode: "bundled-local",
            api: { state: "healthy" },
            database: { state: "healthy" },
            embeddingService: { state: "healthy" },
            redis: { state: "healthy", details: { backend: "local" } }
          })
        );
      }
      return success("{}");
    }
  });

  const result = await runBundledLocalSmoke({
    root: "/repo",
    deps,
    env: {
      KOED_EMBEDDING_MODEL_URL: "https://example.test/model.gguf",
      KOED_EMBEDDING_MODEL_SHA256: "a".repeat(64)
    },
    json: true
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.steps.find((step) => step.step === "embedding-model-install")?.state,
    "installed"
  );
});

test("wait fails fast when child exits before health", async () => {
  const deps = createDeps();
  const child = new EventEmitter();
  child.exitCode = 1;

  await assert.rejects(
    waitForBundledLocalHealthy({
      deps,
      context: { root: "/repo", env: {}, queueBackend: "local" },
      child,
      logs: ["boom"],
      timeoutMs: 1000,
      pollIntervalMs: 1
    }),
    /exited before healthy status.*boom/s
  );
});

test("cleanup terminates child and removes temp home on failure", async () => {
  const deps = createDeps({
    spawnSync: (command, args) => {
      deps.calls.push({ kind: "spawnSync", command, args });
      if (command === "docker" && args[0] === "info")
        return failure("daemon down");
      return success("{}");
    }
  });

  const result = await runBundledLocalSmoke({
    root: "/repo",
    deps,
    env: {},
    json: true
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Docker daemon preflight failed/);
});
