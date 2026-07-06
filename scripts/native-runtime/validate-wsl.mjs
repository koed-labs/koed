#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

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

  const env = {
    ...process.env,
    KOED_HOME: koedHome,
    KOED_PACKAGED_DESKTOP: "1",
    KOED_PACKAGED_RESOURCES_PATH: runtimeRoot
      ? resolve(runtimeRoot, "..")
      : process.env.KOED_PACKAGED_RESOURCES_PATH,
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
    const status = runCli(["status", "--json"]);
    const doctor = runCli(["doctor", "--json"]);
    for (const step of [statusBefore, install, models, start, status, doctor]) {
      if (step.status !== 0)
        errors.push(
          `${step.command} failed: ${step.stderr || step.stdout || step.error}`
        );
    }
    try {
      const parsed = JSON.parse(status.stdout || "{}");
      const apiUrl = parsed?.components?.api?.url ?? parsed?.api?.url;
      if (apiUrl)
        apiProbe = run(
          "curl",
          ["-fsS", `${apiUrl.replace(/\/+$/, "")}/ready`],
          env
        );
      if (apiProbe && apiProbe.status !== 0)
        errors.push(
          `API /ready probe failed: ${apiProbe.stderr || apiProbe.stdout}`
        );
    } catch (error) {
      errors.push(
        `Could not parse status JSON for API probe: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      runCli(["stop", "--json"]);
    }
  }

  const result = {
    ok: errors.length === 0,
    runtimeRoot,
    koedHome,
    isWsl: isWsl(),
    steps,
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
