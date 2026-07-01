#!/usr/bin/env node
/* global console, process */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const desktopRoot = resolve(import.meta.dirname, "..");
const appPath = resolve(desktopRoot, "release/mac/Koed.app");
const executable = resolve(appPath, "Contents/MacOS/Koed");
const resourcesPath = resolve(appPath, "Contents/Resources");
const runner = resolve(
  resourcesPath,
  "app.asar.unpacked/dist-electron/koed-server/node-entrypoint-runner.js"
);
const bundledCli = resolve(
  resourcesPath,
  "app.asar/node_modules/@koed/koed-server/dist/cli.js"
);
const rendererIndex = resolve(resourcesPath, "app-dist/index.html");

const assertExists = (label, path) => {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing at ${path}`);
  }
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

const runBundledServer = (args, env = {}) => {
  const koedHome = mkdtempSync(resolve(tmpdir(), "koed-desktop-smoke-"));
  try {
    const result = spawnSync(
      executable,
      [runner, "node-script", bundledCli, ...args],
      {
        cwd: resourcesPath,
        env: {
          ...process.env,
          ...env,
          ELECTRON_RUN_AS_NODE: "1",
          KOED_HOME: koedHome,
          KOED_REPO_ROOT: resourcesPath,
          KOED_RUNTIME_MODE: "local-personal",
          KOED_DEPENDENCY_MODE: "bundled-local",
          WORK_QUEUE_BACKEND: "local"
        },
        encoding: "utf8"
      }
    );
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } finally {
    rmSync(koedHome, { recursive: true, force: true });
  }
};

assertExists("Packaged app executable", executable);
assertExists("Packaged renderer", rendererIndex);
assertExists("Bundled node entrypoint runner", runner);

const status = runBundledServer(["status", "--json"]);
if (status.status !== 0) {
  throw new Error(
    `status --json failed with ${status.status}: ${status.stderr || status.stdout}`
  );
}
const statusJson = parseJsonOutput("status --json", status.stdout);
if (typeof statusJson.ok !== "boolean" || !statusJson.state) {
  throw new Error(
    `status --json did not include renderable status fields: ${status.stdout}`
  );
}

const doctor = runBundledServer(["doctor", "--json"]);
const doctorJson = parseJsonOutput("doctor --json", doctor.stdout);
if (typeof doctorJson.ok !== "boolean" || !doctorJson.state) {
  throw new Error(
    `doctor --json did not include renderable status fields: ${doctor.stdout}`
  );
}

const stop = runBundledServer(["stop", "--json"]);
const stopJson = parseJsonOutput("stop --json", stop.stdout);
if (typeof stopJson.ok !== "boolean" || !stopJson.state) {
  throw new Error(
    `stop --json did not include renderable status fields: ${stop.stdout}`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      appPath,
      status: { ok: statusJson.ok, state: statusJson.state },
      doctor: { ok: doctorJson.ok, state: doctorJson.state },
      stop: { ok: stopJson.ok, state: stopJson.state }
    },
    null,
    2
  )
);
