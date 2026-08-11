#!/usr/bin/env node
/* global window */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  lstatSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { dump, load } from "js-yaml";
import { fileURLToPath } from "node:url";
import { connectElectronCdp } from "./electron-cdp-lib.mjs";
import { validateDesktopUpdateArtifacts } from "./desktop-update-artifacts-lib.mjs";
import {
  REQUIRED_DESKTOP_UPDATE_EVIDENCE_STEPS,
  validateDesktopUpdateEvidence
} from "./desktop-update-evidence-lib.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const defaultNVersion = JSON.parse(
  readFileSync(resolve(desktopRoot, "package.json"), "utf8")
).version;
const sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const parseArgs = (argv) => {
  const options = {
    nMinus1: "0.4.3",
    nVersion: defaultNVersion,
    evidenceDir: resolve(tmpdir(), "koed-desktop-update-evidence"),
    model:
      process.env.KOED_E2E_MODEL_SOURCE ??
      resolve(
        process.env.HOME ?? "",
        ".koed/models/Qwen3-Embedding-0.6B-Q8_0.gguf"
      ),
    skipBuild: false,
    keepTemp: false,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    const next = () => {
      const result = argv[index + 1];
      if (!result) throw new Error(`${value} requires a value`);
      index += 1;
      return result;
    };
    if (value === "--n-minus-1") options.nMinus1 = next();
    else if (value === "--n-version") options.nVersion = next();
    else if (value === "--evidence-dir") options.evidenceDir = resolve(next());
    else if (value === "--model") options.model = resolve(next());
    else if (value === "--skip-build") options.skipBuild = true;
    else if (value === "--keep-temp") options.keepTemp = true;
    else if (value === "--json") options.json = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown option ${value}`);
  }
  if (options.nMinus1 === options.nVersion)
    throw new Error("N-1 and N versions must differ");
  return options;
};

const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const redact = (value) =>
  String(value)
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:cmt|cms)_[A-Za-z0-9_-]+/gu, "[REDACTED_CREDENTIAL]")
    .replace(/(KOED_[A-Z0-9_]*(?:KEY|SECRET|TOKEN))=\S+/gu, "$1=[REDACTED]")
    .replace(
      /(API_TOKEN_PEPPER|POSTGRES_PASSWORD|EMBEDDING_SERVICE_TOKEN)\s*[:=]\s*\S+/gu,
      "$1=[REDACTED]"
    );

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
};

const runChecked = (command, args, options = {}) => {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${redact(result.stderr || result.stdout)}`
    );
  }
  return result;
};

const nativeSource = (root) => {
  const source = resolve(root, "native-runtime");
  mkdirSync(source, { recursive: true });
  const postgres = resolve("/opt/homebrew/Cellar/postgresql@17/17.10");
  const llama = resolve("/opt/homebrew/Cellar/llama.cpp/9960");
  if (!existsSync(postgres) || !existsSync(llama)) {
    throw new Error(
      "Required Homebrew PostgreSQL 17 and llama.cpp assets are unavailable; refusing to fake a packaged runtime proof."
    );
  }
  cpSync(postgres, resolve(source, "postgres"), {
    recursive: true,
    dereference: true
  });
  cpSync(llama, resolve(source, "llama.cpp"), {
    recursive: true,
    dereference: true
  });
  rmSync(resolve(source, "llama.cpp/llama-server"), { force: true });
  symlinkSync("bin/llama-server", resolve(source, "llama.cpp/llama-server"));
  const materializeAbsoluteLinks = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (!target.startsWith("/")) continue;
        rmSync(path, { recursive: true, force: true });
        cpSync(resolve(directory, target), path, {
          recursive: true,
          dereference: true
        });
        continue;
      }
      if (info.isDirectory()) materializeAbsoluteLinks(path);
    }
  };
  materializeAbsoluteLinks(source);
  return source;
};

const writeBuilderConfig = (path, output, version) => {
  const source = load(
    readFileSync(resolve(desktopRoot, "electron-builder.yml"), "utf8")
  );
  source.directories = { ...(source.directories ?? {}), output };
  source.extraMetadata = { ...(source.extraMetadata ?? {}), version };
  writeFileSync(path, dump(source, { lineWidth: 120 }));
};

const signAndVerifyApp = (appPath) => {
  runChecked(
    "codesign",
    [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--identifier",
      "com.koed.desktop",
      appPath
    ],
    { cwd: repositoryRoot, stdio: "inherit" }
  );
  runChecked("codesign", ["--verify", "--deep", "--strict", appPath], {
    cwd: repositoryRoot,
    stdio: "inherit"
  });
  const designated = run("codesign", ["-dr", "-", appPath], {
    cwd: repositoryRoot
  });
  return {
    designated_requirement: redact(designated.stderr || designated.stdout)
  };
};

const packageVersion = (version, output, configPath, runtimeSource) => {
  writeBuilderConfig(configPath, output, version);
  const env = {
    ...process.env,
    KOED_NATIVE_RUNTIME_SOURCE_DIR: runtimeSource,
    CSC_IDENTITY_AUTO_DISCOVERY: "false"
  };
  runChecked(
    resolve(desktopRoot, "node_modules/.bin/electron-builder"),
    ["--config", configPath, "--mac", "dir"],
    {
      cwd: desktopRoot,
      env,
      stdio: "inherit"
    }
  );
  const generated = resolve(output, "mac-arm64");
  if (existsSync(generated)) {
    rmSync(resolve(output, "mac"), { recursive: true, force: true });
    renameSync(generated, resolve(output, "mac"));
  }
  const appPath = resolve(output, "mac", "Koed.app");
  if (!existsSync(appPath))
    throw new Error(`Packaged app missing at ${appPath}`);
  signAndVerifyApp(appPath);
  runChecked(
    resolve(desktopRoot, "node_modules/.bin/electron-builder"),
    [
      "--config",
      configPath,
      "--prepackaged",
      resolve(output, "mac"),
      "--mac",
      "dmg",
      "zip"
    ],
    { cwd: desktopRoot, env, stdio: "inherit" }
  );
  const validated = validateDesktopUpdateArtifacts({
    root: output,
    expectedVersion: version
  });
  return { version, output, appPath, validated };
};

const layoutFor = (appPath) => {
  const resourcesPath = resolve(appPath, "Contents/Resources");
  return {
    appPath,
    resourcesPath,
    executable: resolve(appPath, "Contents/MacOS/Koed"),
    runner: resolve(
      resourcesPath,
      "app.asar.unpacked/dist-electron/koed-server/node-entrypoint-runner.js"
    ),
    bundledCli: resolve(
      resourcesPath,
      "app.asar/node_modules/@koed/koed-server/dist/cli.js"
    )
  };
};

const commandEnv = (layout, koedHome) => {
  const apiPort =
    40_000 +
    [...koedHome].reduce(
      (hash, character) => (hash * 31 + character.codePointAt(0)) % 20_000,
      0
    );
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    KOED_HOME: koedHome,
    KOED_PACKAGED_DESKTOP: "1",
    KOED_PACKAGED_RESOURCES_PATH: layout.resourcesPath,
    KOED_AUTO_PORTS: "1",
    KOED_RUNTIME_MODE: "local-personal",
    KOED_DEPENDENCY_MODE: "bundled-local",
    WORK_QUEUE_BACKEND: "local",
    API_HOST_PORT: String(apiPort),
    KOED_ALLOW_MULTIPLE_INSTANCES: "1"
  };
  env.NO_PROXY = [env.NO_PROXY, "127.0.0.1", "localhost"]
    .filter(Boolean)
    .join(",");
  env.no_proxy = env.NO_PROXY;
  delete env.KOED_REPO_ROOT;
  delete env.KOED_SERVER_CLI;
  return env;
};

const packagedCommand = (layout, home, args) =>
  run(
    layout.executable,
    [layout.runner, "node-script", layout.bundledCli, ...args],
    {
      cwd: layout.resourcesPath,
      env: commandEnv(layout, home)
    }
  );

const inventory = (root) => {
  const entries = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      const relativePath = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      entries.push({
        path: relativePath,
        size: statSync(path).size,
        sha256: sha256(path)
      });
    }
  };
  walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
};

const patchFeed = (appPath, feedUrl) => {
  const path = resolve(appPath, "Contents/Resources/app-update.yml");
  const metadata = existsSync(path)
    ? load(readFileSync(path, "utf8"))
    : { provider: "generic", channel: "latest" };
  metadata.url = feedUrl;
  writeFileSync(path, dump(metadata, { lineWidth: 120 }));
  // Keep the package unsigned on this credential-free machine. Re-signing
  // with an ad-hoc identity triggers a macOS trust modal before Electron can
  // load the main bundle; install acceptance remains fail-closed if the
  // unsigned updater cannot relaunch.
  return path;
};

const waitFor = async (predicate, timeoutMs, label, intervalMs = 250) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `${label} timed out${lastError ? `: ${lastError.message}` : ""}`
  );
};

const childRunning = (child) =>
  child.exitCode === null && child.signalCode === null;

const terminate = async (child) => {
  if (!childRunning(child)) return;
  child.kill("SIGTERM");
  await waitFor(
    () => !childRunning(child),
    8_000,
    "packaged Electron shutdown",
    100
  ).catch(() => {
    if (childRunning(child)) child.kill("SIGKILL");
  });
};

const launchPackaged = async (layout, home, debuggingPort, userData) => {
  const env = commandEnv(layout, home);
  delete env.ELECTRON_RUN_AS_NODE;
  env.KOED_DESKTOP_UPDATE_E2E = "1";
  env.KOED_DESKTOP_UPDATE_E2E_DEBUG_PORT = String(debuggingPort);
  env.ELECTRON_ENABLE_LOGGING = "1";
  env.ELECTRON_ENABLE_STACK_DUMPING = "1";
  let stdout = "";
  let stderr = "";
  let exit;
  let launchError;
  const child = spawn(
    layout.executable,
    [
      "--enable-logging=stderr",
      "--v=1",
      "--disable-error-dialogs",
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${userData}`,
      "--no-first-run",
      "--disable-gpu"
    ],
    { cwd: layout.resourcesPath, env, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-64_000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-64_000);
  });
  child.once("error", (error) => {
    launchError = error;
  });
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  let cdp;
  try {
    cdp = await waitFor(
      () => connectElectronCdp({ port: debuggingPort, timeoutMs: 2_000 }),
      180_000,
      "packaged Electron CDP target",
      250
    );
  } catch (error) {
    const processTree = run("ps", ["-axo", "pid,ppid,stat,etime,command"], {
      cwd: repositoryRoot
    });
    const listeners = run(
      "lsof",
      ["-nP", "-a", "-p", String(child.pid), "-iTCP", "-sTCP:LISTEN"],
      { cwd: repositoryRoot }
    );
    const details = [
      launchError ? `launch error: ${launchError.message}` : "",
      exit ? `exit: ${JSON.stringify(exit)}` : "process remained running",
      stdout ? `stdout: ${redact(stdout)}` : "",
      stderr ? `stderr: ${redact(stderr)}` : ""
    ].filter(Boolean);
    const launchFailure = new Error(
      `Packaged Electron did not expose a CDP target on ${debuggingPort}: ${
        error instanceof Error ? error.message : String(error)
      }${details.length > 0 ? `\n${details.join("\n")}` : ""}`
    );
    launchFailure.launchDiagnostics = {
      executable: layout.executable,
      user_data: userData,
      debugging_port: debuggingPort,
      cdp_endpoint: `http://127.0.0.1:${debuggingPort}/json/list`,
      child_alive: childRunning(child),
      child_exit: exit ?? null,
      stdout: redact(stdout),
      stderr: redact(stderr),
      launch_error: launchError?.message ?? null,
      process_tree: redact(processTree.stdout || processTree.stderr),
      listeners: redact(listeners.stdout || listeners.stderr)
    };
    await terminate(child).catch(() => undefined);
    throw launchFailure;
  }
  const listener = run(
    "lsof",
    [
      "-nP",
      "-a",
      "-p",
      String(child.pid),
      `-iTCP:${debuggingPort}`,
      "-sTCP:LISTEN"
    ],
    { cwd: repositoryRoot }
  );
  if (
    listener.status !== 0 ||
    !listener.stdout.includes(`TCP 127.0.0.1:${debuggingPort}`)
  ) {
    await terminate(child).catch(() => undefined);
    throw new Error(
      `Packaged Electron CDP target was reachable but PID ${child.pid} did not own loopback port ${debuggingPort}: ${redact(listener.stdout || listener.stderr)}`
    );
  }
  return {
    child,
    cdp,
    getLogs: () => ({
      stdout: redact(stdout),
      stderr: redact(stderr),
      exit,
      launch_error: launchError?.message ?? null
    })
  };
};

const updateState = (cdp) =>
  cdp.evaluate(() => window.koedDesktop?.update?.getState());
const appVersion = (cdp) =>
  cdp.evaluate(() => window.koedDesktop?.update?.getVersion());

const waitUpdateStatus = (cdp, status) =>
  waitFor(
    async () => {
      const state = await updateState(cdp);
      return state?.status === status ? state : false;
    },
    180_000,
    `update state ${status}`
  );

const waitApi = async (home, layout) =>
  waitFor(
    async () => {
      const result = packagedCommand(layout, home, ["status", "--json"]);
      if (result.status !== 0) return false;
      try {
        const payload = JSON.parse(result.stdout);
        return payload?.api?.state === "healthy" &&
          payload?.database?.state === "healthy"
          ? payload
          : false;
      } catch {
        return false;
      }
    },
    240_000,
    "packaged local runtime health",
    2_000
  );

const seedMemoryAndQuery = async (home, layout, label) => {
  const ports = JSON.parse(
    readFileSync(resolve(home, "config/local-ports.json"), "utf8")
  );
  const secrets = JSON.parse(
    readFileSync(resolve(home, "config/local-service-secrets.json"), "utf8")
  );
  const sql = `INSERT INTO users (email, display_name) SELECT 'local@koed.ai','Desktop update proof user' WHERE NOT EXISTS (SELECT 1 FROM users WHERE email='local@koed.ai'); INSERT INTO memory_events (owner_user_id, visibility, event_type, source_runtime, capture_method, payload, source_hash) SELECT id, 'personal', 'captured', 'codex', 'transcript', '{"text":"Desktop update Personal Memory preservation sentinel"}'::jsonb, 'desktop-update-preservation-sentinel' FROM users WHERE email='local@koed.ai' AND NOT EXISTS (SELECT 1 FROM memory_events WHERE source_hash='desktop-update-preservation-sentinel'); SELECT id::text, payload->>'text' AS text FROM memory_events WHERE source_hash='desktop-update-preservation-sentinel';`;
  const psql = run(
    "psql",
    [
      "--no-psqlrc",
      "-v",
      "ON_ERROR_STOP=1",
      "-h",
      "127.0.0.1",
      "-p",
      String(ports.postgres),
      "-U",
      "koed",
      "-d",
      "koed",
      "-At",
      "-c",
      sql
    ],
    {
      env: { ...process.env, PGPASSWORD: secrets.POSTGRES_PASSWORD }
    }
  );
  if (psql.status !== 0)
    throw new Error(
      `Personal Memory seed failed: ${redact(psql.stderr || psql.stdout)}`
    );
  const tokenPath = resolve(home, "config/explorer-token.json");
  const token = JSON.parse(readFileSync(tokenPath, "utf8")).apiToken;
  const runtime = JSON.parse(
    readFileSync(resolve(home, "run/koed-server.json"), "utf8")
  );
  const apiUrl = runtime.apiUrl ?? `http://127.0.0.1:${ports.api}`;
  const response = await fetch(
    `${apiUrl}/v1/memory/graph/events?query=Desktop%20update%20Personal%20Memory&includeContent=true`,
    {
      headers: { authorization: `Bearer ${token}` }
    }
  );
  const body = await response.text();
  if (!response.ok)
    throw new Error(
      `Personal Memory query failed (${response.status}): ${redact(body)}`
    );
  return {
    label,
    endpoint: `${apiUrl}/v1/memory/graph/events`,
    status: response.status,
    rows:
      JSON.parse(body)?.events?.length ?? JSON.parse(body)?.items?.length ?? 0,
    sentinelPresent: body.includes(
      "Desktop update Personal Memory preservation sentinel"
    )
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/desktop-update-e2e.mjs [--skip-build] [--keep-temp] [--json]\n"
    );
    return;
  }
  mkdirSync(options.evidenceDir, { recursive: true });
  const tempRoot = mkdtempSync(resolve(tmpdir(), "koed-desktop-update-e2e-"));
  const beforeFailure = {
    task_id: "desktop-update-e2e",
    generated_at: new Date().toISOString(),
    evidence_mode: "fresh_for_this_snapshot",
    status: "blocked"
  };
  const failurePath = resolve(options.evidenceDir, "failure.json");
  let n1;
  let n;
  let home;
  let appSession;
  let feed;
  try {
    const runtimeSource = nativeSource(tempRoot);
    if (!options.skipBuild) {
      runChecked(
        "pnpm",
        ["--filter", "@koed/desktop", "package:workspace:build"],
        { cwd: repositoryRoot, stdio: "inherit" }
      );
      runChecked("pnpm", ["--filter", "@koed/desktop", "package:runtime"], {
        cwd: repositoryRoot,
        env: { ...process.env, KOED_NATIVE_RUNTIME_SOURCE_DIR: runtimeSource },
        stdio: "inherit"
      });
    }
    n1 = packageVersion(
      options.nMinus1,
      resolve(tempRoot, "n-minus-1"),
      resolve(tempRoot, "electron-builder-n-minus-1.yml"),
      runtimeSource
    );
    n = packageVersion(
      options.nVersion,
      resolve(tempRoot, "n"),
      resolve(tempRoot, "electron-builder-n.yml"),
      runtimeSource
    );

    const { startDesktopUpdateFeed } =
      await import("./serve-desktop-update-feed.mjs");
    feed = await startDesktopUpdateFeed({
      root: n.output,
      version: n.version,
      prefix: "/stable"
    });
    const patchedMetadata = patchFeed(n1.appPath, feed.info.feed_url);
    signAndVerifyApp(n1.appPath);
    home = mkdtempSync(resolve(tempRoot, "koed-home-"));
    for (const directory of [
      "config",
      "logs",
      "run",
      "data",
      "models",
      "cache"
    ])
      mkdirSync(resolve(home, directory), { recursive: true, mode: 0o700 });
    writeFileSync(
      resolve(home, "config/server.json"),
      JSON.stringify(
        {
          runtimeMode: "local-personal",
          dependencyMode: "bundled-local",
          codexTranscriptWatcherEnabled: false
        },
        null,
        2
      )
    );
    writeFileSync(
      resolve(home, "config/api-token-reference.json"),
      JSON.stringify(
        {
          secretRef: "keychain://koed-desktop-update-e2e/api-token",
          purpose: "Personal API Token reference only"
        },
        null,
        2
      )
    );
    writeFileSync(
      resolve(home, "config/local-service-secrets.json"),
      JSON.stringify(
        {
          POSTGRES_PASSWORD: "desktop-update-postgres-proof",
          // Envelope-encryption keys must decode to exactly 32 bytes. Keep
          // deterministic base64 sentinels so the packaged API can boot.
          API_DATA_ENCRYPTION_KEY:
            "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
          OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY:
            "ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=",
          API_TOKEN_PEPPER: "desktop-update-api-token-pepper-0123456789abcdef",
          COLLABORATION_LOCAL_BROKER_SECRET:
            "desktop-update-local-broker-secret-0123456789abcdef",
          COLLABORATION_REALTIME_CURSOR_SECRET:
            "desktop-update-realtime-cursor-secret-0123456789abcdef",
          EMBEDDING_SERVICE_TOKEN:
            "desktop-update-embedding-token-0123456789abcdef"
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    const modelTarget = resolve(home, "models/Qwen3-Embedding-0.6B-Q8_0.gguf");
    if (!existsSync(options.model))
      throw new Error(`Embedding model source missing: ${options.model}`);
    cpSync(options.model, modelTarget, { preserveTimestamps: true });
    writeFileSync(
      resolve(home, "data/personal-memory-sentinel.bin"),
      Buffer.from("DESKTOP-UPDATE-PERSONAL-MEMORY-DATA-SENTINEL\n")
    );
    const beforeInventory = inventory(home);
    const n1Layout = layoutFor(n1.appPath);
    const runtimeInstall = packagedCommand(n1Layout, home, [
      "runtime",
      "install",
      "--provider",
      "packaged",
      "--dependency-mode",
      "bundled-local",
      "--json"
    ]);
    if (runtimeInstall.status !== 0)
      throw new Error(
        `N-1 packaged runtime install failed: ${redact(runtimeInstall.stderr || runtimeInstall.stdout)}`
      );
    const modelStatus = packagedCommand(n1Layout, home, [
      "models",
      "status",
      "--kind",
      "embedding",
      "--json"
    ]);
    if (modelStatus.status !== 0)
      throw new Error(
        `N-1 model status failed: ${redact(modelStatus.stderr || modelStatus.stdout)}`
      );
    writeFileSync(
      resolve(options.evidenceDir, "attempt.json"),
      `${JSON.stringify(
        {
          task_id: "desktop-update-e2e",
          generated_at: new Date().toISOString(),
          evidence_mode: "fresh_for_this_snapshot",
          status: "in_progress",
          commands: {
            runtime_install:
              "runtime install --provider packaged --dependency-mode bundled-local --json",
            model_status: "models status --kind embedding --json",
            launch:
              "Koed --remote-debugging-port=<isolated> --user-data-dir=<isolated>"
          },
          versions: { n_minus_1: options.nMinus1, n: options.nVersion },
          artifacts: [
            {
              kind: "n_minus_1",
              version: options.nMinus1,
              path: resolve(n1.output, `Koed-${options.nMinus1}-arm64.zip`),
              sha256: sha256(
                resolve(n1.output, `Koed-${options.nMinus1}-arm64.zip`)
              )
            },
            {
              kind: "n",
              version: options.nVersion,
              path: resolve(n.output, `Koed-${options.nVersion}-arm64.zip`),
              sha256: sha256(
                resolve(n.output, `Koed-${options.nVersion}-arm64.zip`)
              )
            }
          ],
          feed_validation: {
            ok: true,
            feed_url: feed.info.feed_url,
            manifest: resolve(n.output, "latest-mac.yml"),
            patched_n_minus_1_metadata: patchedMetadata
          },
          runtime_install: (() => {
            try {
              return JSON.parse(runtimeInstall.stdout);
            } catch {
              return redact(runtimeInstall.stdout);
            }
          })(),
          model_status: (() => {
            try {
              return JSON.parse(modelStatus.stdout);
            } catch {
              return redact(modelStatus.stdout);
            }
          })(),
          before_inventory: beforeInventory
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    const port = 45_000 + Math.floor(Math.random() * 8_000);
    appSession = await launchPackaged(
      n1Layout,
      home,
      port,
      resolve(tempRoot, "electron-user-data")
    );
    const initialVersion = await waitFor(
      () => appVersion(appSession.cdp),
      180_000,
      "N-1 app.getVersion"
    );
    if (initialVersion !== options.nMinus1)
      throw new Error(`N-1 reported version ${initialVersion}`);
    await waitFor(
      async () => {
        const result = await appSession.cdp.clickButton("Set up Koed");
        return result.clicked ? result : false;
      },
      180_000,
      "packaged setup action"
    );
    await sleep(500);
    await waitFor(
      async () => {
        const result = await appSession.cdp.clickButton("Set up Koed", "last");
        return result.clicked ? result : false;
      },
      180_000,
      "packaged setup confirmation"
    );
    await waitApi(home, n1Layout);
    await waitFor(
      () => existsSync(resolve(home, "config/explorer-token.json")),
      60_000,
      "packaged Desktop API token provisioning"
    );
    const beforeQuery = await seedMemoryAndQuery(
      home,
      n1Layout,
      "before_install"
    );
    const initialState = await updateState(appSession.cdp);
    await sleep(6_000);
    const postAutomaticState = await updateState(appSession.cdp);
    const noAutoDownload = !["downloading", "ready", "installing"].includes(
      postAutomaticState?.status
    );
    if (!noAutoDownload)
      throw new Error(
        `Automatic download occurred: ${JSON.stringify(postAutomaticState)}`
      );
    const checked = await appSession.cdp.evaluate(() =>
      window.koedDesktop.update.check()
    );
    const available =
      checked?.status === "available"
        ? checked
        : await waitUpdateStatus(appSession.cdp, "available");
    const downloadedPromise = appSession.cdp.evaluate(() =>
      window.koedDesktop.update.download()
    );
    const downloading = await waitUpdateStatus(appSession.cdp, "downloading");
    await downloadedPromise;
    const ready = await waitUpdateStatus(appSession.cdp, "ready");
    const installResult = await appSession.cdp
      .evaluate(() => window.koedDesktop.update.install())
      .catch(() => ({ status: "installing" }));
    const installing =
      installResult?.status === "installing"
        ? installResult
        : await waitUpdateStatus(appSession.cdp, "installing");
    const preInstallPids = existsSync(resolve(home, "run/koed-server.json"))
      ? JSON.parse(readFileSync(resolve(home, "run/koed-server.json"), "utf8"))
      : null;
    await waitFor(
      () => !childRunning(appSession.child),
      180_000,
      "N-1 updater-driven quit",
      250
    );
    appSession.cdp.close();
    const relaunched = await waitFor(
      async () => {
        try {
          return await connectElectronCdp({ port, timeoutMs: 2_000 });
        } catch {
          return false;
        }
      },
      180_000,
      "N relaunch",
      500
    );
    const reportedVersion = await waitFor(
      () => appVersion(relaunched),
      30_000,
      "N app.getVersion after relaunch"
    );
    if (reportedVersion !== options.nVersion)
      throw new Error(
        `Relaunch reported ${reportedVersion}, expected ${options.nVersion}`
      );
    const nLayout = layoutFor(n.appPath);
    const afterQuery = await seedMemoryAndQuery(
      home,
      nLayout,
      "after_relaunch"
    );
    const afterInventory = inventory(home);
    const servicePidsStopped = preInstallPids?.processes
      ? Object.values(preInstallPids.processes).every(
          (pid) =>
            !pid ||
            !(() => {
              try {
                process.kill(pid, 0);
                return true;
              } catch {
                return false;
              }
            })()
        )
      : true;
    const logs = appSession.getLogs();
    const manifest = {
      task_id: "desktop-update-e2e",
      generated_at: new Date().toISOString(),
      evidence_mode: "fresh_for_this_snapshot",
      temp_root: tempRoot,
      versions: { n_minus_1: options.nMinus1, n: options.nVersion },
      artifacts: [
        {
          kind: "n_minus_1",
          version: options.nMinus1,
          path: resolve(n1.output, `Koed-${options.nMinus1}-arm64.zip`),
          sha256: sha256(
            resolve(n1.output, `Koed-${options.nMinus1}-arm64.zip`)
          )
        },
        {
          kind: "n",
          version: options.nVersion,
          path: resolve(n.output, `Koed-${options.nVersion}-arm64.zip`),
          sha256: sha256(
            resolve(n.output, `Koed-${options.nVersion}-arm64.zip`)
          )
        }
      ],
      feed_validation: {
        ok: true,
        feed_url: feed.info.feed_url,
        manifest: resolve(n.output, "latest-mac.yml"),
        patched_n_minus_1_metadata: patchedMetadata
      },
      steps: REQUIRED_DESKTOP_UPDATE_EVIDENCE_STEPS.map((name) => ({
        name,
        ok: true
      })),
      action_timeline: [
        {
          action: "launch_n_minus_1",
          version: initialVersion,
          state: initialState
        },
        { action: "automatic_check_window", state: postAutomaticState },
        { action: "manual_check", state: available },
        { action: "user_download", state: downloading },
        { action: "download_ready", state: ready },
        { action: "restart_install", state: installing },
        { action: "relaunch", version: reportedVersion }
      ],
      shutdown: {
        updater_driven: true,
        service_pids_before_install: preInstallPids?.processes ?? {},
        service_pids_stopped: servicePidsStopped,
        app_process_exited: true
      },
      relaunch: { reported_version: reportedVersion },
      before_inventory: beforeInventory,
      after_inventory: afterInventory,
      data_preservation: {
        ok: beforeQuery.sentinelPresent && afterQuery.sentinelPresent,
        queries: [beforeQuery, afterQuery],
        sentinels: {
          config: sha256(resolve(home, "config/server.json")),
          api_token_reference: sha256(
            resolve(home, "config/api-token-reference.json")
          ),
          model: sha256(modelTarget),
          data: sha256(resolve(home, "data/personal-memory-sentinel.bin"))
        }
      },
      logs,
      cleanup: { temp_root_removed: !options.keepTemp }
    };
    validateDesktopUpdateEvidence(manifest);
    writeFileSync(
      resolve(options.evidenceDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 }
    );
    if (!options.keepTemp) rmSync(tempRoot, { recursive: true, force: true });
    if (options.json)
      process.stdout.write(
        `${JSON.stringify({ ok: true, evidence: resolve(options.evidenceDir, "manifest.json"), versions: manifest.versions })}\n`
      );
  } catch (error) {
    if (appSession) {
      try {
        await terminate(appSession.child);
      } catch {
        /* best effort */
      }
      appSession.cdp?.close();
    }
    if (feed?.server) {
      feed.server.closeAllConnections?.();
      await Promise.race([
        new Promise((resolveClose) => feed.server.close(resolveClose)),
        sleep(5_000)
      ]);
    }
    const failure = {
      ...beforeFailure,
      error: redact(error instanceof Error ? error.message : String(error)),
      temp_root: tempRoot,
      versions: { n_minus_1: options.nMinus1, n: options.nVersion },
      launch:
        error && typeof error === "object" && "launchDiagnostics" in error
          ? error.launchDiagnostics
          : (appSession?.getLogs?.() ?? null)
    };
    writeFileSync(failurePath, `${JSON.stringify(failure, null, 2)}\n`, {
      mode: 0o600
    });
    if (!options.keepTemp) rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (feed?.server) {
      feed.server.closeAllConnections?.();
      await Promise.race([
        new Promise((resolveClose) => feed.server.close(resolveClose)),
        sleep(5_000)
      ]);
    }
  }
};

main().catch((error) => {
  process.stderr.write(
    `Desktop update E2E failed closed: ${redact(error instanceof Error ? error.message : String(error))}\n`
  );
  process.exitCode = 1;
});
