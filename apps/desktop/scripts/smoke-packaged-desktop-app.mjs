#!/usr/bin/env node
/* global console, process, setTimeout */
import { listPackage } from "@electron/asar";
import {
  cpSync,
  readdirSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createOwnedDiagnosticsDir,
  writeDiagnosticTail
} from "./smoke-diagnostics.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const sourceCheckoutRoot = resolve(desktopRoot, "..", "..");
const sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const parseArgs = (argv) => {
  const options = {
    json: false,
    build: false,
    missingAssets: false,
    diagnosticsDir: undefined,
    timeoutMs: 180_000,
    pollIntervalMs: 2_000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value === "--build") {
      options.build = true;
      continue;
    }
    if (value === "--missing-assets") {
      options.missingAssets = true;
      continue;
    }
    if (value === "--diagnostics-dir") {
      const diagnosticsDir = argv[index + 1]?.trim();
      if (!diagnosticsDir) {
        throw new Error("--diagnostics-dir requires a path.");
      }
      options.diagnosticsDir = resolve(diagnosticsDir);
      index += 1;
      continue;
    }
    if (value === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (value === "--poll-interval-ms") {
      options.pollIntervalMs = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown packaged desktop smoke option: ${value}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer.");
  }
  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error("--poll-interval-ms must be a positive integer.");
  }
  return options;
};

const usage = `Usage: pnpm desktop:package:smoke:mac -- [options]

Options:
  --json                    Emit JSON result
  --build                   Build packaged app before smoke
  --missing-assets          Expect packaged native runtime assets to be missing
  --diagnostics-dir <path>  Create a curated diagnostics child under this path
  --timeout-ms <number>     Max wait for healthy status (default 180000)
  --poll-interval-ms <num>  Poll interval (default 2000)
  --help, -h                Show this help
`;

const buildPackage = () => {
  const result = spawnSync("pnpm", ["package:mac"], {
    cwd: desktopRoot,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`package:mac failed with ${result.status ?? 1}`);
  }
};

const assertExists = (label, path) => {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing at ${path}`);
  }
};

const pickExecutable = (appRoot) => {
  for (const preferred of ["Koed", "koed"]) {
    const candidate = resolve(appRoot, preferred);
    if (existsSync(candidate) && (statSync(candidate).mode & 0o111) !== 0) {
      return candidate;
    }
  }
  for (const entry of readdirSync(appRoot, { withFileTypes: true })) {
    const candidate = resolve(appRoot, entry.name);
    if (!entry.isFile()) continue;
    if ((statSync(candidate).mode & 0o111) !== 0) {
      return candidate;
    }
  }
  throw new Error(`Could not find packaged app executable under ${appRoot}`);
};

const resolvePackagedLayout = () => {
  const explicitAppPath =
    process.env.KOED_DESKTOP_PACKAGE_SMOKE_APP_PATH?.trim();
  const explicitResourcesPath =
    process.env.KOED_DESKTOP_PACKAGE_SMOKE_RESOURCES_PATH?.trim();
  const explicitExecutable =
    process.env.KOED_DESKTOP_PACKAGE_SMOKE_EXECUTABLE?.trim();
  const explicitRunner = process.env.KOED_DESKTOP_PACKAGE_SMOKE_RUNNER?.trim();
  const appPath =
    explicitAppPath ??
    (process.platform === "darwin"
      ? resolve(desktopRoot, "release", "mac", "Koed.app")
      : process.platform === "linux"
        ? resolve(desktopRoot, "release", "linux-unpacked")
        : undefined);
  if (!appPath) {
    throw new Error(
      "Packaged Desktop smoke needs Darwin or Linux, or explicit KOED_DESKTOP_PACKAGE_SMOKE_APP_PATH/RESOURCES_PATH overrides."
    );
  }
  const resourcesPath =
    explicitResourcesPath ??
    (process.platform === "darwin"
      ? resolve(appPath, "Contents", "Resources")
      : resolve(appPath, "resources"));
  const executable =
    explicitExecutable ??
    (process.platform === "darwin"
      ? resolve(appPath, "Contents", "MacOS", "Koed")
      : pickExecutable(appPath));
  const runner =
    explicitRunner ??
    resolve(
      resourcesPath,
      "app.asar.unpacked",
      "dist-electron",
      "koed-server",
      "node-entrypoint-runner.js"
    );
  const appAsarPath = resolve(resourcesPath, "app.asar");
  const bundledCli = resolve(
    resourcesPath,
    "app.asar",
    "node_modules",
    "@koed",
    "koed-server",
    "dist",
    "cli.js"
  );
  const rendererIndex = resolve(resourcesPath, "app-dist", "index.html");
  const runtimeRoot = resolve(resourcesPath, "koed-runtime");
  return {
    appPath,
    resourcesPath,
    executable,
    runner,
    appAsarPath,
    bundledCli,
    rendererIndex,
    runtimeRoot
  };
};

const createSmokeEnv = (layout, koedHome, extraEnv = {}) => {
  const env = {
    ...process.env,
    ...extraEnv,
    ELECTRON_RUN_AS_NODE: "1",
    KOED_HOME: koedHome,
    KOED_PACKAGED_DESKTOP: "1",
    KOED_PACKAGED_RESOURCES_PATH: layout.resourcesPath,
    KOED_RUNTIME_MODE: "local-personal",
    KOED_DEPENDENCY_MODE: "bundled-local",
    WORK_QUEUE_BACKEND: "local"
  };
  delete env.KOED_REPO_ROOT;
  delete env.KOED_SERVER_CLI;
  delete env.KOED_ALLOW_PACKAGED_SOURCE_FALLBACK;
  return env;
};

const parseJsonOutput = (label, output) => {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `${label} did not produce JSON: ${error instanceof Error ? error.message : String(error)}\n${output}`,
      { cause: error }
    );
  }
};

const killPidBestEffort = (pid) => {
  if (typeof pid !== "number" || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  sleepSync(500);
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
};

const pidIsRunning = (pid) => {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readableDiagnostic = (label, path) => {
  if (!existsSync(path)) return `${label}: not created`;
  try {
    const contents = readFileSync(path, "utf8");
    const maxCharacters = 64 * 1024;
    const output =
      contents.length > maxCharacters
        ? `[last ${maxCharacters} characters]\n${contents.slice(-maxCharacters)}`
        : contents;
    return `${label} (${path}):\n${output}`;
  } catch (error) {
    return `${label} (${path}): could not read (${error instanceof Error ? error.message : String(error)})`;
  }
};

const preserveFailureDiagnostics = ({ layout, koedHome, diagnosticsDir }) => {
  const status = runPackagedCommand(layout, koedHome, ["status", "--json"]);
  const supervisorLog = resolve(koedHome, "logs", "supervisor.log");
  const postgresLog = resolve(koedHome, "logs", "postgres.log");
  const runtimeState = resolve(koedHome, "run", "koed-server.json");
  const localPorts = resolve(koedHome, "config", "local-ports.json");
  const ownedDiagnosticsDir = diagnosticsDir
    ? createOwnedDiagnosticsDir(diagnosticsDir)
    : undefined;
  if (ownedDiagnosticsDir) {
    writeFileSync(
      resolve(ownedDiagnosticsDir, "status.json"),
      status.stdout || "{}",
      {
        mode: 0o600
      }
    );
    for (const [source, relativePath, tailOnly] of [
      [supervisorLog, "logs/supervisor.log", true],
      [postgresLog, "logs/postgres.log", true],
      [runtimeState, "run/koed-server.json", false],
      [localPorts, "config/local-ports.json", false]
    ]) {
      if (!existsSync(source)) continue;
      const target = resolve(ownedDiagnosticsDir, relativePath);
      mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
      if (tailOnly) {
        writeDiagnosticTail(source, target);
      } else {
        cpSync(source, target);
      }
    }
  }
  return [
    readableDiagnostic("Supervisor log", supervisorLog),
    readableDiagnostic("Postgres log", postgresLog),
    readableDiagnostic("Runtime state", runtimeState),
    `Last status:\n${status.stdout || status.stderr || "not available"}`,
    ...(ownedDiagnosticsDir
      ? [`Preserved diagnostics: ${ownedDiagnosticsDir}`]
      : [])
  ].join("\n\n");
};

const runPackagedCommand = (layout, koedHome, args, extraEnv = {}) => {
  const result = spawnSync(
    layout.executable,
    [layout.runner, "node-script", layout.bundledCli, ...args],
    {
      cwd: layout.resourcesPath,
      env: createSmokeEnv(layout, koedHome, extraEnv),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
};

const assertNoSourceCheckoutResolution = (label, payload) => {
  const sourceMarkers = [
    resolve(sourceCheckoutRoot, "apps", "api"),
    resolve(sourceCheckoutRoot, "apps", "worker"),
    resolve(sourceCheckoutRoot, "apps", "embedding-service"),
    resolve(sourceCheckoutRoot, "packages", "koed-server"),
    resolve(sourceCheckoutRoot, "packages", "mcp-server"),
    resolve(sourceCheckoutRoot, "packages", "db"),
    resolve(sourceCheckoutRoot, "vendor")
  ];
  const hits = [];
  const visit = (value, path = []) => {
    if (typeof value === "string") {
      if (sourceMarkers.some((marker) => value.includes(marker))) {
        hits.push({ path: path.join("."), value });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, String(index)]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, [...path, key]);
      }
    }
  };
  visit(payload);
  if (hits.length > 0) {
    throw new Error(
      `${label} resolved packaged runtime artifacts from source checkout: ${JSON.stringify(hits, null, 2)}`
    );
  }
};

const assertPackagedJsSurface = (layout) => {
  assertExists("Packaged app executable", layout.executable);
  assertExists("Packaged app asar", layout.appAsarPath);
  assertExists("Packaged renderer", layout.rendererIndex);
  assertExists("Bundled node entrypoint runner", layout.runner);
  for (const [label, relativePath] of [
    ["Packaged API artifact", "api/dist/index.js"],
    ["Packaged Worker artifact", "worker/dist/index.js"],
    ["Packaged Embedding Service artifact", "embedding-service/dist/index.js"],
    ["Packaged Explorer artifact", "explorer-dist/index.html"],
    ["Packaged MCP Server artifact", "mcp-server/dist/cli.js"],
    [
      "Packaged Supported Capture Hook artifact",
      "mcp-server/dist/capture-hook.js"
    ],
    ["Packaged DB package artifact", "api/node_modules/@koed/db/dist/index.js"],
    [
      "Packaged DB migration journal",
      "api/node_modules/@koed/db/drizzle/meta/_journal.json"
    ]
  ]) {
    assertExists(label, resolve(layout.runtimeRoot, relativePath));
  }
  const entries = listPackage(layout.appAsarPath);
  const entrySet = new Set(entries);
  const requiredEntries = [
    "/node_modules/@koed/koed-server/package.json",
    "/node_modules/@koed/koed-server/dist/cli.js"
  ];
  const missing = requiredEntries.filter((entry) => !entrySet.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `Packaged koed-server runtime files are missing from app.asar: ${missing.join(", ")}`
    );
  }
  const forbidden = entries.filter(
    (entry) =>
      entry.startsWith("/node_modules/@koed/koed-server/src") ||
      entry.startsWith("/node_modules/@koed/koed-server/tsconfig.json") ||
      entry.startsWith(
        "/node_modules/@koed/koed-server/tsconfig.tsbuildinfo"
      ) ||
      (entry.startsWith("/node_modules/@koed/koed-server/") &&
        entry.endsWith(".test.ts"))
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Packaged koed-server includes source/test/build metadata: ${forbidden.join(", ")}`
    );
  }
};

const assertPackagedDaemonReady = (payload, label) => {
  const requiredComponents = ["database", "redis", "explorer"];
  const unhealthy = requiredComponents.filter(
    (component) => payload?.[component]?.state !== "healthy"
  );
  if (unhealthy.length > 0) {
    throw new Error(
      `${label} was not ready (${unhealthy.join(", ")}): ${JSON.stringify(payload, null, 2)}`
    );
  }
};

const assertInstalled = (payload, label) => {
  if (payload?.ok !== true || !payload?.state) {
    throw new Error(
      `${label} did not report install state: ${JSON.stringify(payload, null, 2)}`
    );
  }
};

const assertMissingAssets = (payload, label) => {
  if (payload?.ok === true) {
    throw new Error(
      `${label} unexpectedly reported ok: ${JSON.stringify(payload, null, 2)}`
    );
  }
  const text = JSON.stringify(payload, null, 2);
  if (!/packaged|missing|install runtime assets/i.test(text)) {
    throw new Error(
      `${label} did not include actionable missing-asset guidance: ${text}`
    );
  }
};

const smokePackageStatus = (layout, koedHome) => {
  const packageStatus = runPackagedCommand(layout, koedHome, [
    "package",
    "status",
    "--json"
  ]);
  const packageStatusJson = parseJsonOutput(
    "package status --json",
    packageStatus.stdout
  );
  assertNoSourceCheckoutResolution("package status --json", packageStatusJson);
  if (
    packageStatus.status !== 0 &&
    packageStatusJson?.state !== "missing" &&
    packageStatusJson?.state !== "partial" &&
    packageStatusJson?.state !== "incompatible"
  ) {
    throw new Error(
      `package status --json failed with unexpected state: ${JSON.stringify(packageStatusJson, null, 2)}`
    );
  }
  return packageStatusJson;
};

const smokeMissingAssets = (layout, koedHome) => {
  const packageStatus = smokePackageStatus(layout, koedHome);
  const runtimeStatus = runPackagedCommand(layout, koedHome, [
    "runtime",
    "status",
    "--provider",
    "packaged",
    "--json"
  ]);
  const runtimeStatusJson = parseJsonOutput(
    "runtime status --json",
    runtimeStatus.stdout
  );
  assertNoSourceCheckoutResolution("runtime status --json", runtimeStatusJson);
  const doctor = runPackagedCommand(layout, koedHome, ["doctor", "--json"]);
  const doctorJson = parseJsonOutput("doctor --json", doctor.stdout);
  assertNoSourceCheckoutResolution("doctor --json", doctorJson);
  assertMissingAssets(doctorJson, "doctor --json");
  return {
    packageStatus,
    runtimeStatus: runtimeStatusJson,
    doctor: doctorJson,
    doctorExitCode: doctor.status
  };
};

const waitForHealthyStatus = async ({
  layout,
  koedHome,
  timeoutMs,
  pollIntervalMs,
  supervisorPid
}) => {
  const startedAt = Date.now();
  let lastStatus = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (!pidIsRunning(supervisorPid)) {
      throw new Error(
        `Packaged daemon supervisor ${supervisorPid} exited before becoming healthy.`
      );
    }
    const status = runPackagedCommand(layout, koedHome, ["status", "--json"]);
    if (status.status !== 0) {
      lastStatus = parseJsonOutput("status --json", status.stdout || "{}");
      await sleep(pollIntervalMs);
      continue;
    }
    lastStatus = parseJsonOutput("status --json", status.stdout);
    const readyComponents = ["database", "redis", "explorer"].every(
      (component) => lastStatus?.[component]?.state === "healthy"
    );
    if (readyComponents) {
      assertNoSourceCheckoutResolution("status --json", lastStatus);
      return lastStatus;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for packaged daemon health. Last status:\n${JSON.stringify(lastStatus, null, 2)}`
  );
};

const smokeHealthyDaemon = async (layout, koedHome, options) => {
  const packageStatus = smokePackageStatus(layout, koedHome);
  const runtimeStatus = runPackagedCommand(layout, koedHome, [
    "runtime",
    "status",
    "--provider",
    "packaged",
    "--json"
  ]);
  const runtimeStatusJson = parseJsonOutput(
    "runtime status --json",
    runtimeStatus.stdout
  );
  assertNoSourceCheckoutResolution("runtime status --json", runtimeStatusJson);
  if (runtimeStatus.status !== 0) {
    assertMissingAssets(
      runtimeStatusJson,
      "runtime status --json before install"
    );
  } else if (runtimeStatusJson.ok !== true) {
    throw new Error(
      `runtime status --json was not ok: ${JSON.stringify(runtimeStatusJson, null, 2)}`
    );
  }

  const install = runPackagedCommand(layout, koedHome, [
    "runtime",
    "install",
    "--provider",
    "packaged",
    "--dependency-mode",
    "bundled-local",
    "--json"
  ]);
  if (install.status !== 0) {
    throw new Error(
      `runtime install --json failed with ${install.status}: ${install.stderr || install.stdout}`
    );
  }
  const installJson = parseJsonOutput("runtime install --json", install.stdout);
  assertNoSourceCheckoutResolution("runtime install --json", installJson);
  assertInstalled(installJson, "runtime install --json");

  const installedRuntimeStatus = runPackagedCommand(layout, koedHome, [
    "runtime",
    "status",
    "--provider",
    "packaged",
    "--json"
  ]);
  if (installedRuntimeStatus.status !== 0) {
    throw new Error(
      `runtime status --json after install failed with ${installedRuntimeStatus.status}: ${installedRuntimeStatus.stderr || installedRuntimeStatus.stdout}`
    );
  }
  const installedRuntimeStatusJson = parseJsonOutput(
    "runtime status --json after install",
    installedRuntimeStatus.stdout
  );
  assertNoSourceCheckoutResolution(
    "runtime status --json after install",
    installedRuntimeStatusJson
  );
  assertInstalled(
    installedRuntimeStatusJson,
    "runtime status --json after install"
  );

  const modelStatus = runPackagedCommand(layout, koedHome, [
    "models",
    "status",
    "--kind",
    "embedding",
    "--json"
  ]);
  if (modelStatus.status !== 0) {
    throw new Error(
      `models status --json failed with ${modelStatus.status}: ${modelStatus.stderr || modelStatus.stdout}`
    );
  }
  const modelStatusJson = parseJsonOutput(
    "models status --json",
    modelStatus.stdout
  );
  assertNoSourceCheckoutResolution("models status --json", modelStatusJson);
  if (modelStatusJson.state !== "installed") {
    const modelInstall = runPackagedCommand(layout, koedHome, [
      "models",
      "install",
      "--kind",
      "embedding",
      "--json"
    ]);
    if (modelInstall.status !== 0) {
      throw new Error(
        `models install --json failed with ${modelInstall.status}: ${modelInstall.stderr || modelInstall.stdout}`
      );
    }
    const modelInstallJson = parseJsonOutput(
      "models install --json",
      modelInstall.stdout
    );
    assertNoSourceCheckoutResolution("models install --json", modelInstallJson);
    if (modelInstallJson.ok !== true) {
      throw new Error(
        `models install --json was not ok: ${JSON.stringify(modelInstallJson, null, 2)}`
      );
    }
  }

  const start = runPackagedCommand(layout, koedHome, [
    "start",
    "--daemon",
    "--json"
  ]);
  if (start.status !== 0) {
    throw new Error(
      `start --daemon --json failed with ${start.status}: ${start.stderr || start.stdout}`
    );
  }
  const startJson = parseJsonOutput("start --daemon --json", start.stdout);
  assertNoSourceCheckoutResolution("start --daemon --json", startJson);
  if (startJson.ok === true && typeof startJson.startedPid === "number") {
    options.daemonPids?.push(startJson.startedPid);
  }
  if (startJson.ok !== true || typeof startJson.startedPid !== "number") {
    throw new Error(
      `start --daemon --json did not include daemon start details: ${start.stdout}`
    );
  }

  const firstStatus = await waitForHealthyStatus({
    layout,
    koedHome,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    supervisorPid: startJson.startedPid
  });

  const reconnectStatus = runPackagedCommand(layout, koedHome, [
    "status",
    "--json"
  ]);
  const reconnectJson = parseJsonOutput(
    "status --json",
    reconnectStatus.stdout
  );
  assertNoSourceCheckoutResolution("status --json", reconnectJson);
  assertPackagedDaemonReady(reconnectJson, "status --json after reconnect");

  const stop = runPackagedCommand(layout, koedHome, ["stop", "--json"]);
  if (stop.status !== 0) {
    throw new Error(
      `stop --json failed with ${stop.status}: ${stop.stderr || stop.stdout}`
    );
  }
  const stopJson = parseJsonOutput("stop --json", stop.stdout);
  assertNoSourceCheckoutResolution("stop --json", stopJson);
  if (stopJson.ok !== true) {
    throw new Error(`stop --json was not ok: ${stop.stdout}`);
  }

  const restart = runPackagedCommand(layout, koedHome, [
    "start",
    "--daemon",
    "--json"
  ]);
  if (restart.status !== 0) {
    throw new Error(
      `reopen start --daemon --json failed with ${restart.status}: ${restart.stderr || restart.stdout}`
    );
  }
  const restartJson = parseJsonOutput("start --daemon --json", restart.stdout);
  assertNoSourceCheckoutResolution("reopen start --daemon --json", restartJson);
  if (restartJson.ok === true && typeof restartJson.startedPid === "number") {
    options.daemonPids?.push(restartJson.startedPid);
  }
  if (restartJson.ok !== true || typeof restartJson.startedPid !== "number") {
    throw new Error(
      `reopen start --daemon --json did not include daemon start details: ${restart.stdout}`
    );
  }
  const reopenedStatus = await waitForHealthyStatus({
    layout,
    koedHome,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    supervisorPid: restartJson.startedPid
  });

  const finalStop = runPackagedCommand(layout, koedHome, ["stop", "--json"]);
  if (finalStop.status !== 0) {
    throw new Error(
      `final stop --json failed with ${finalStop.status}: ${finalStop.stderr || finalStop.stdout}`
    );
  }
  const finalStopJson = parseJsonOutput("stop --json", finalStop.stdout);
  assertNoSourceCheckoutResolution("final stop --json", finalStopJson);
  if (finalStopJson.ok !== true) {
    throw new Error(`final stop --json was not ok: ${finalStop.stdout}`);
  }

  return {
    packageStatus,
    runtimeStatus: runtimeStatusJson,
    install: installJson,
    installedRuntimeStatus: installedRuntimeStatusJson,
    modelStatus: modelStatusJson,
    firstStatus,
    reconnectStatus: reconnectJson,
    stop: stopJson,
    restart: restartJson,
    reopenedStatus,
    finalStop: finalStopJson,
    startPid: startJson.startedPid,
    restartPid: restartJson.startedPid
  };
};

const run = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (options.build) {
    buildPackage();
  }
  const layout = resolvePackagedLayout();
  assertPackagedJsSurface(layout);

  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-smoke-"));
  const daemonPids = [];
  try {
    if (options.missingAssets) {
      const result = smokeMissingAssets(layout, koedHome);
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              mode: "missing-assets",
              appPath: layout.appPath,
              ...result
            },
            null,
            2
          )
        );
      }
      return;
    }

    const result = await smokeHealthyDaemon(layout, koedHome, {
      ...options,
      daemonPids
    });
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: "healthy-daemon",
            appPath: layout.appPath,
            runtime: { ok: result.install.ok, state: result.install.state },
            status: {
              ok: result.firstStatus.ok,
              state: result.firstStatus.state
            },
            reconnect: {
              ok: result.reconnectStatus.ok,
              state: result.reconnectStatus.state
            },
            restart: {
              ok: result.reopenedStatus.ok,
              state: result.reopenedStatus.state
            },
            stop: { ok: result.finalStop.ok, state: result.finalStop.state },
            startPid: result.startPid,
            restartPid: result.restartPid
          },
          null,
          2
        )
      );
      return;
    }
    console.log("Packaged Desktop smoke passed.");
  } catch (error) {
    const diagnostics = preserveFailureDiagnostics({
      layout,
      koedHome,
      diagnosticsDir: options.diagnosticsDir
    });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\n${diagnostics}`,
      { cause: error }
    );
  } finally {
    runPackagedCommand(layout, koedHome, ["stop", "--json"]);
    for (const pid of daemonPids.toReversed()) {
      killPidBestEffort(pid);
    }
    spawnSync("pkill", ["-f", koedHome], { stdio: "ignore" });
    rmSync(koedHome, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
