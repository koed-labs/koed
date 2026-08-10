import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  buildBundledLocalSmokeEnvironment,
  cleanupBundledLocalSmoke,
  parseBundledLocalSmokeArgs,
  preflightBundledLocalSmoke,
  runBundledLocalSmoke,
  runJsonCommand,
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
    readFile: async () =>
      "DATABASE_URL=postgres://koed:pw@127.0.0.1:15432/koed\nAPI_TOKEN_PEPPER=pepper\n",
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
    parseBundledLocalSmokeArgs([
      "--",
      "--json",
      "--full",
      "--install-runtime",
      "--timeout-ms",
      "50"
    ]),
    {
      json: true,
      full: true,
      installRuntime: true,
      timeoutMs: 50,
      pollIntervalMs: 2000
    }
  );
  assert.throws(() => parseBundledLocalSmokeArgs(["--wat"]), /Unknown/);
});

test("builds isolated native bundled-local environment with unique ports", async () => {
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
  assert.equal(context.env.KOED_BUNDLED_POSTGRES_MODE, "native");
  assert.equal(context.env.KOED_BUNDLED_EMBEDDING_MODE, "native");
  assert.deepEqual(context.expectedServices, [
    "postgres-native",
    "embedding-service-native"
  ]);
  assert.equal(new Set(Object.values(context.ports)).size, 4);
});

test("full preflight does not require Docker", () => {
  const deps = createDeps({
    spawnSync: (command, args) => {
      deps.calls.push({ kind: "spawnSync", command, args });
      if (command === "docker") return failure("daemon down");
      return success();
    }
  });

  preflightBundledLocalSmoke(deps, { full: true });
  assert.equal(
    deps.calls.some((call) => call.command === "docker"),
    false
  );
});

test("preflight does not require Docker", () => {
  const deps = createDeps({
    spawnSync: (command, args) => {
      deps.calls.push({ kind: "spawnSync", command, args });
      if (command === "docker") return failure("daemon down");
      return success();
    }
  });

  preflightBundledLocalSmoke(deps);
  assert.equal(
    deps.calls.some((call) => call.command === "docker"),
    false
  );
});

test("run skips model install when model URL or checksum env is absent", async () => {
  const deps = createDeps({
    fileExists: () => true,
    spawnSync: (command, args) => {
      deps.calls.push({ kind: "spawnSync", command, args });
      if (args.includes("status")) {
        return success(
          JSON.stringify({
            dependencyMode: "bundled-local",
            api: { state: "healthy" },
            database: { state: "healthy" },
            embeddingService: { state: "healthy" },
            workerQueues: { state: "healthy" },
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

test("run can explicitly install Homebrew runtime before native checks", async () => {
  let runtimeStatusCount = 0;
  const deps = createDeps({
    fileExists: () => true,
    spawnSync: (command, args) => {
      deps.calls.push({ kind: "spawnSync", command, args });
      if (args.includes("runtime") && args.includes("status")) {
        runtimeStatusCount += 1;
        return success(
          JSON.stringify(
            runtimeStatusCount === 1
              ? {
                  ok: false,
                  state: "missing",
                  koedRuntime: { linked: false }
                }
              : {
                  ok: true,
                  state: "installed",
                  koedRuntime: {
                    linked: true,
                    postgresBinDir: "/tmp/koed/runtime/postgres/bin",
                    llamaServerBin: "/tmp/koed/runtime/llama.cpp/llama-server"
                  }
                }
          )
        );
      }
      if (args.includes("runtime") && args.includes("install")) {
        return success(
          JSON.stringify({
            ok: true,
            state: "installed",
            installedPackages: ["postgresql@17"],
            linkedPaths: ["/tmp/koed/runtime/postgres/bin/initdb"]
          })
        );
      }
      if (args.includes("status")) {
        return success(
          JSON.stringify({
            dependencyMode: "bundled-local",
            api: { state: "healthy" },
            database: { state: "healthy" },
            embeddingService: { state: "healthy" },
            workerQueues: { state: "healthy" },
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
    json: true,
    installRuntime: true
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(
    result.steps.find((step) => step.step === "homebrew-runtime-install")
      ?.state,
    "installed"
  );
  assert.equal(
    deps.calls.some(
      (call) =>
        call.kind === "spawnSync" &&
        call.args?.includes("runtime") &&
        call.args?.includes("install")
    ),
    true
  );
});

test("run installs and verifies model when model env is present", async () => {
  const deps = createDeps({
    fileExists: () => true,
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
            workerQueues: { state: "healthy" },
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

test("runJsonCommand includes JSON stdout on nonzero exit", () => {
  const deps = createDeps({
    spawnSync: () => ({
      status: 1,
      stdout: JSON.stringify({
        ok: false,
        state: "checksum_mismatch",
        message: "downloaded checksum mismatch",
        sha256: "actual"
      }),
      stderr: "",
      error: undefined
    })
  });

  assert.throws(
    () =>
      runJsonCommand(deps, "node", ["cli.js", "models", "install", "--json"], {
        cwd: "/repo",
        env: {}
      }),
    /checksum_mismatch.*downloaded checksum mismatch/s
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

test("smoke fails clearly when native resources are missing", async () => {
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
            workerQueues: { state: "healthy" },
            redis: { state: "healthy", details: { backend: "local" } }
          })
        );
      }
      return success("{}");
    },
    fileExists: () => false
  });

  const result = await runBundledLocalSmoke({
    root: "/repo",
    deps,
    env: {},
    json: true,
    full: false
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Native bundled-local smoke resources missing/);
});

test("full smoke creates API Token and calls personal capture recall path", async () => {
  const deps = createDeps({
    fileExists: () => true,
    spawnSync: (command, args, options) => {
      deps.calls.push({ kind: "spawnSync", command, args, options });
      if (args.includes("api-token:create")) {
        assert.match(options.env.DATABASE_URL, /:4102\/koed$/);
        return success("Created Koed API token.\nToken: cmt_smoke\n");
      }
      if (args.includes("status")) {
        return success(
          JSON.stringify({
            dependencyMode: "bundled-local",
            api: { state: "healthy" },
            database: { state: "healthy" },
            embeddingService: { state: "healthy" },
            workerQueues: { state: "healthy" },
            redis: { state: "healthy", details: { backend: "local" } }
          })
        );
      }
      return success("{}");
    },
    fetch: async (url) => {
      deps.calls.push({ kind: "fetch", url });
      if (String(url).endsWith("/self-host/smoke-test")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              marker: "koed-marker",
              queueDrain: {
                embedding: { waiting: 0, active: 0, delayed: 0, failed: 0 },
                compaction: { waiting: 0, active: 0, delayed: 0, failed: 0 }
              },
              recall: { hits: 1, topHit: { text: "koed-marker" } }
            })
        };
      }
      if (String(url).endsWith("/self-host/status")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              components: {
                workerQueues: {
                  embedding: { waiting: 0, active: 0, delayed: 0, failed: 0 },
                  compaction: { waiting: 0, active: 0, delayed: 0, failed: 0 }
                }
              }
            })
        };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    }
  });

  const result = await runBundledLocalSmoke({
    root: "/repo",
    deps,
    env: {
      KOED_EMBEDDING_MODEL_PATH: "/model.gguf",
      KOED_EMBEDDING_MODEL_SHA256: "a".repeat(64)
    },
    json: true,
    full: true
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(
    result.steps.find((step) => step.step === "personal-capture-recall")?.state,
    "passed"
  );
  assert.equal(
    deps.calls.some(
      (call) => call.kind === "spawnSync" && call.args?.includes("stop")
    ),
    true
  );
});

test("cleanup destroys child stdio after stopping smoke process", async () => {
  const deps = createDeps({ fileExists: () => true });
  const child = new EventEmitter();
  let stdoutDestroyed = false;
  let stderrDestroyed = false;
  child.exitCode = null;
  child.stdout = { destroy: () => (stdoutDestroyed = true) };
  child.stderr = { destroy: () => (stderrDestroyed = true) };
  child.kill = (signal) => {
    deps.calls.push({ kind: "kill", signal });
    child.exitCode = 0;
    child.emit("exit", 0);
    return true;
  };

  await cleanupBundledLocalSmoke({
    deps,
    context: { root: "/repo", koedHome: "/tmp/koed-smoke", env: {} },
    child
  });

  assert.equal(stdoutDestroyed, true);
  assert.equal(stderrDestroyed, true);
  assert.equal(
    deps.calls.some(
      (call) => call.kind === "kill" && call.signal === "SIGTERM"
    ),
    true
  );
});

test("cleanup removes temp home on native resource failure", async () => {
  const deps = createDeps({
    fileExists: () => false
  });

  const result = await runBundledLocalSmoke({
    root: "/repo",
    deps,
    env: {},
    json: true
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Native bundled-local smoke resources missing/);
  assert.equal(
    deps.calls.some((call) => call.kind === "rm"),
    true
  );
  assert.equal(
    deps.calls.some((call) => call.command === "docker"),
    false
  );
});
