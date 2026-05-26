#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceDir = path.join(root, "apps", "embedding-service");
const venvDir = path.join(serviceDir, ".venv");
const ruff = path.join(venvDir, "bin", "ruff");
const mypy = path.join(venvDir, "bin", "mypy");

const requireTool = (toolPath, toolName) => {
  if (fs.existsSync(toolPath)) {
    return;
  }

  throw new Error(
    [
      `Missing ${toolName} in apps/embedding-service/.venv.`,
      "Set up the Python environment with:",
      "  pnpm setup:python"
    ].join("\n")
  );
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

try {
  requireTool(ruff, "ruff");
  requireTool(mypy, "mypy");
  run("ruff check apps/embedding-service", ruff, ["check", "."]);
  run(
    "python unit tests apps/embedding-service",
    path.join(venvDir, "bin", "python"),
    ["-m", "unittest", "discover"]
  );
  run("mypy apps/embedding-service", mypy, [
    "app.py",
    "benchmark_embeddings.py",
    "env_config.py"
  ]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
