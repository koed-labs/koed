#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceDir = path.join(root, "apps", "embedding-service");
const venvDir = path.join(serviceDir, ".venv");
const python = path.join(venvDir, "bin", "python");
const pythonCommand = process.env.KOED_PYTHON ?? "python3.12";

const resolveExecutable = (command) => {
  if (path.isAbsolute(command)) {
    if (!fs.existsSync(command)) {
      throw new Error(`${command} does not exist.`);
    }
    return command;
  }

  const result = spawnSync("command", ["-v", command], {
    encoding: "utf8",
    shell: true
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`${command} was not found on PATH.`);
  }

  return result.stdout.trim();
};

const run = (label, command, args) => {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, args, {
    cwd: serviceDir,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

const readCommandVersion = (command) => {
  const result = spawnSync(
    command,
    [
      "-c",
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
    ],
    {
      cwd: serviceDir,
      encoding: "utf8"
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `${command} failed while checking Python version`
    );
  }

  return result.stdout.trim();
};

const readVenvVersion = () => {
  if (!fs.existsSync(python)) {
    return null;
  }

  const result = spawnSync(
    python,
    [
      "-c",
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
    ],
    {
      cwd: serviceDir,
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim();
};

try {
  const pythonExecutable = resolveExecutable(pythonCommand);

  if (fs.existsSync(venvDir) && !fs.existsSync(python)) {
    throw new Error(
      [
        "apps/embedding-service/.venv exists but does not contain bin/python.",
        "Remove that incomplete local venv and rerun setup:",
        "  rm -rf apps/embedding-service/.venv",
        "  pnpm setup:python"
      ].join("\n")
    );
  }

  const venvVersion = readVenvVersion();
  if (venvVersion && venvVersion !== "3.12") {
    throw new Error(
      [
        `apps/embedding-service/.venv uses Python ${venvVersion}; expected Python 3.12.`,
        "Remove that local venv and rerun setup:",
        "  rm -rf apps/embedding-service/.venv",
        "  pnpm setup:python"
      ].join("\n")
    );
  }

  if (!fs.existsSync(python)) {
    const commandVersion = readCommandVersion(pythonExecutable);
    if (commandVersion !== "3.12") {
      throw new Error(
        [
          `${pythonExecutable} is Python ${commandVersion}; expected Python 3.12.`,
          "Point setup at a Python 3.12 binary:",
          "  KOED_PYTHON=/path/to/python3.12 pnpm setup:python"
        ].join("\n")
      );
    }
    run("create apps/embedding-service/.venv", pythonExecutable, [
      "-m",
      "venv",
      ".venv"
    ]);
  }

  run("install embedding-service dev requirements", python, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-cache-dir",
    "-r",
    "requirements-dev.txt"
  ]);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
