#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
const piCommand = process.env.KOED_PI_EXECUTABLE ?? "pi";
const run = (args) =>
  spawnSync(piCommand, args, {
    encoding: "utf8",
    env: { ...process.env, KOED_HOME: koedHome }
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
