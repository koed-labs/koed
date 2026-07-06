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
    KOED_PACKAGED_DESKTOP: "1",
    KOED_PACKAGED_RESOURCES_PATH: runtimeRoot
      ? resolve(runtimeRoot, "..")
      : process.env.KOED_PACKAGED_RESOURCES_PATH
  };
  const cli = resolve("packages", "koed-server", "dist", "cli.js");
  const status = existsSync(cli)
    ? run(
        process.execPath,
        [cli, "runtime", "status", "--provider", "packaged", "--json"],
        env
      )
    : undefined;
  if (!status) errors.push("Build @koed/koed-server before WSL validation.");
  else if (status.status !== 0)
    errors.push(`runtime status failed: ${status.stderr || status.stdout}`);

  const result = {
    ok: errors.length === 0,
    runtimeRoot,
    koedHome,
    isWsl: isWsl(),
    status,
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
