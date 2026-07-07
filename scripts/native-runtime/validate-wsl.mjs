#!/usr/bin/env node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const parseArgs = (argv) => {
  const options = { json: false, runtimeRoot: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--") continue;
    if (value === "--json") options.json = true;
    else if (value === "--runtime-root") options.runtimeRoot = argv[++i] ?? "";
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  options.runtimeRoot ||= process.env.KOED_NATIVE_RUNTIME_SOURCE_DIR ?? "";
  return options;
};

const isWsl = () => {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
};

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { encoding: "utf8", env });
  return {
    command: [command, ...args].join(" "),
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message
  };
};

const stepFailed = (step) => step.status !== 0 || step.error;

const stepFailure = (step) =>
  `${step.command} failed: ${step.stderr || step.stdout || step.error}`;

const resolvePackagedResourcesPath = (runtimeRoot) => {
  const resolvedRuntimeRoot = resolve(runtimeRoot);
  if (basename(resolvedRuntimeRoot) === "koed-runtime") {
    return {
      resourcesPath: resolve(resolvedRuntimeRoot, ".."),
      cleanup: () => {}
    };
  }
  if (existsSync(resolve(resolvedRuntimeRoot, "koed-runtime"))) {
    return { resourcesPath: resolvedRuntimeRoot, cleanup: () => {} };
  }
  const wrapper = mkdtempSync(resolve(tmpdir(), "koed-wsl-runtime-resources-"));
  symlinkSync(resolvedRuntimeRoot, resolve(wrapper, "koed-runtime"), "dir");
  return {
    resourcesPath: wrapper,
    cleanup: () => rmSync(wrapper, { recursive: true, force: true })
  };
};

const parseJson = (label, text) => {
  try {
    return JSON.parse(text || "{}");
  } catch (error) {
    throw new Error(
      `Could not parse ${label} JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

const statusLooksReady = (payload) => {
  if (payload?.ok === true && payload?.state === "healthy") return true;
  const components = payload?.components ?? payload?.services ?? payload;
  const api = components?.api ?? payload?.api;
  const database =
    components?.database ?? components?.postgres ?? payload?.database;
  const explorer = components?.explorer ?? payload?.explorer;
  const isHealthy = (entry) =>
    entry?.state === "healthy" ||
    entry?.status === "ok" ||
    entry?.ready === true;
  return isHealthy(api) && isHealthy(database) && isHealthy(explorer);
};

const waitForStatus = ({ runCli, timeoutMs = 180_000, intervalMs = 2_000 }) => {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = runCli(["status", "--json"]);
    if (!stepFailed(last)) {
      const parsed = parseJson("status", last.stdout);
      if (statusLooksReady(parsed)) return { step: last, parsed };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
  return {
    step: last,
    parsed: last?.stdout ? parseJson("status", last.stdout) : undefined
  };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: pnpm native-runtime:validate:wsl -- --runtime-root <koed-runtime> [--json]"
    );
    return;
  }
  const errors = [];
  if (process.platform !== "linux")
    errors.push("WSL validation must run inside Linux/WSL.");
  if (!isWsl())
    errors.push(
      "WSL validation must run inside WSL; WSL_DISTRO_NAME or /proc/version marker missing."
    );
  const koedHome = process.env.KOED_HOME ? resolve(process.env.KOED_HOME) : "";
  if (!koedHome) errors.push("Set KOED_HOME before WSL validation.");
  if (koedHome.startsWith("/mnt/"))
    errors.push(
      "KOED_HOME must live on the WSL Linux filesystem, not /mnt/<drive>."
    );
  const runtimeRoot = options.runtimeRoot ? resolve(options.runtimeRoot) : "";
  if (!runtimeRoot || !existsSync(runtimeRoot))
    errors.push(
      "Provide an existing --runtime-root or KOED_NATIVE_RUNTIME_SOURCE_DIR."
    );

  const resourceResolution = runtimeRoot
    ? resolvePackagedResourcesPath(runtimeRoot)
    : {
        resourcesPath: process.env.KOED_PACKAGED_RESOURCES_PATH,
        cleanup: () => {}
      };
  const env = {
    ...process.env,
    KOED_HOME: koedHome,
    KOED_PACKAGED_DESKTOP: "1",
    KOED_PACKAGED_RESOURCES_PATH: resourceResolution.resourcesPath,
    KOED_DEPENDENCY_MODE: "bundled-local",
    KOED_AUTO_PORTS: "1",
    WORK_QUEUE_BACKEND: "local"
  };
  const cli = resolve("packages", "koed-server", "dist", "cli.js");
  const steps = [];
  const runCli = (args) => {
    const step = run(process.execPath, [cli, ...args], env);
    steps.push(step);
    return step;
  };
  let apiProbe;
  let readyStatus;
  try {
    if (!existsSync(cli)) {
      errors.push("Build @koed/koed-server before WSL validation.");
    } else if (errors.length === 0) {
      const statusBefore = runCli([
        "runtime",
        "status",
        "--provider",
        "packaged",
        "--json"
      ]);
      // A missing pre-install status is expected for a fresh KOED_HOME. It should
      // still produce actionable JSON, so keep it in steps but do not fail here.
      if (!statusBefore.stdout.trim()) {
        errors.push(stepFailure(statusBefore));
      }

      const install = runCli([
        "runtime",
        "install",
        "--provider",
        "packaged",
        "--dependency-mode",
        "bundled-local",
        "--json"
      ]);
      const models = runCli([
        "models",
        "install",
        "--kind",
        "embedding",
        "--json"
      ]);
      const start = runCli(["start", "--daemon", "--json"]);
      for (const step of [install, models, start]) {
        if (stepFailed(step)) errors.push(stepFailure(step));
      }

      if (errors.length === 0) {
        readyStatus = waitForStatus({ runCli });
        if (!readyStatus.step || stepFailed(readyStatus.step)) {
          errors.push(
            readyStatus.step
              ? stepFailure(readyStatus.step)
              : "Timed out waiting for status."
          );
        } else if (!statusLooksReady(readyStatus.parsed)) {
          errors.push(
            `Timed out waiting for ready status: ${JSON.stringify(readyStatus.parsed)}`
          );
        }

        const parsed =
          readyStatus.parsed ??
          parseJson("status", readyStatus.step?.stdout ?? "{}");
        const apiUrl = parsed?.components?.api?.url ?? parsed?.api?.url;
        if (apiUrl) {
          apiProbe = run(
            "curl",
            ["-fsS", `${apiUrl.replace(/\/+$/, "")}/ready`],
            env
          );
          if (stepFailed(apiProbe))
            errors.push(
              `API /ready probe failed: ${apiProbe.stderr || apiProbe.stdout || apiProbe.error}`
            );
        } else {
          errors.push(
            "Could not resolve API URL from status JSON for /ready probe."
          );
        }
      }
    }
  } finally {
    if (existsSync(cli)) runCli(["stop", "--json"]);
    resourceResolution.cleanup();
  }

  const result = {
    ok: errors.length === 0,
    runtimeRoot,
    packagedResourcesPath: resourceResolution.resourcesPath,
    koedHome,
    isWsl: isWsl(),
    steps,
    readyStatus,
    apiProbe,
    errors
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log("WSL native runtime validation passed.");
  else console.error(errors.join("\n"));
  process.exit(result.ok ? 0 : 1);
};

try {
  main();
} catch (error) {
  if (process.argv.includes("--json"))
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    );
  else console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
