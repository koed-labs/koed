#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv.includes("--remove")
  ? "remove"
  : process.argv.includes("--check")
    ? "check"
    : "configure";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "packages/mcp-server/integrations/pi");
const koedHome = resolve(process.env.KOED_HOME ?? `${homedir()}/.koed`);
const target = resolve(koedHome, "integrations/pi");
const allowedEnvironment = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "PI_CODING_AGENT_DIR",
  "SYSTEMROOT",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT"
];
const childEnvironment = {
  ...Object.fromEntries(
    allowedEnvironment.flatMap((name) =>
      process.env[name] ? [[name, process.env[name]]] : []
    )
  ),
  KOED_HOME: koedHome
};
const configuredPi = process.env.KOED_PI_EXECUTABLE?.trim();
if (configuredPi && !isAbsolute(configuredPi)) {
  console.error("KOED_PI_EXECUTABLE must be an absolute path.");
  process.exit(1);
}
const executableNames =
  process.platform === "win32" ? ["pi.exe", "pi.cmd", "pi"] : ["pi"];
let piCommand = configuredPi;
if (!piCommand) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    piCommand = executableNames
      .map((name) => join(directory, name))
      .find((candidate) => {
        try {
          return statSync(candidate).isFile();
        } catch {
          return false;
        }
      });
    if (piCommand) break;
  }
}
if (!piCommand) {
  console.error(
    "Pi was not found. Install Pi, or set KOED_PI_EXECUTABLE to its absolute path."
  );
  process.exit(1);
}
piCommand = realpathSync(piCommand);
if (!statSync(piCommand).isFile()) {
  console.error(`Pi executable is not a file: ${piCommand}`);
  process.exit(1);
}
if (process.platform !== "win32") accessSync(piCommand, constants.X_OK);
const run = (args) =>
  spawnSync(piCommand, args, {
    encoding: "utf8",
    env: childEnvironment,
    timeout: 30_000
  });

const version = run(["--version"]);
if (mode !== "remove" && version.status !== 0) {
  console.error(
    version.stderr?.trim() ||
      "Pi was not found. Install Pi before configuring Koed."
  );
  process.exit(1);
}
const parsed = version.stdout
  ?.trim()
  .match(/^(\d+)\.(\d+)\.(\d+)/)
  ?.slice(1)
  .map(Number);
if (
  mode !== "remove" &&
  (!parsed ||
    parsed[0] < 0 ||
    (parsed[0] === 0 &&
      (parsed[1] < 84 || (parsed[1] === 84 && parsed[2] < 2))))
) {
  console.error(
    `Pi ${version.stdout?.trim() || "version"} is unsupported. Koed requires Pi 0.84.2 or newer.`
  );
  process.exit(1);
}

if (mode !== "remove") {
  const models = run(["--list-models"]);
  const modelCount =
    models.status === 0
      ? models.stdout
          .split(/\r?\n/)
          .slice(1)
          .filter((line) => /^(\S+)\s+(\S+)/.test(line.trim())).length
      : 0;
  if (modelCount === 0) {
    console.error(
      "Pi has no authenticated models. Authenticate at least one Pi model before setup."
    );
    process.exit(1);
  }
}

if (mode === "remove") {
  run(["remove", target]);
  rmSync(target, { recursive: true, force: true });
  console.log(
    "Koed Pi integration removed; unrelated Pi settings and packages were preserved."
  );
  process.exit(0);
}

if (mode === "check") {
  const list = run(["list"]);
  if (
    !existsSync(resolve(target, "extensions/koed.mjs")) ||
    list.status !== 0 ||
    (!list.stdout.includes(target) &&
      !list.stdout.includes(realpathSync(target)))
  ) {
    console.error("Koed Pi integration needs repair. Run `pnpm pi:configure`.");
    process.exit(1);
  }
  console.log("Koed Pi integration is configured.");
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
const install = run(["install", target]);
if (install.status !== 0) {
  console.error(install.stderr?.trim() || "Pi package installation failed.");
  process.exit(1);
}
console.log("Pi integration configured.");
console.log(`KOED_HOME: ${koedHome}`);
console.log(`Package: ${target}`);
console.log(
  "Start Pi normally; memory_answer and memory_intake_propose will load automatically."
);
