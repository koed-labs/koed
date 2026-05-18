#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonVenv = path.join(root, "apps", "embedding-service", ".venv");
const pythonRuff = path.join(pythonVenv, "bin", "ruff");
const pythonMypy = path.join(pythonVenv, "bin", "mypy");
const requirePythonChecks =
  process.env.CI === "true" || process.env.KOED_REQUIRE_PYTHON_CHECKS === "1";

const steps = [
  ["lint", "pnpm", ["lint"]],
  ["typecheck", "pnpm", ["typecheck"]],
  ["test typecheck", "pnpm", ["typecheck:test"]]
];

if (
  requirePythonChecks ||
  (fs.existsSync(pythonRuff) && fs.existsSync(pythonMypy))
) {
  steps.push(["python checks", "pnpm", ["test:python"]]);
} else {
  console.log(
    [
      "\n> verify: python checks skipped",
      "apps/embedding-service/.venv/bin/ruff or .venv/bin/mypy is missing.",
      "Run `pnpm setup:python`,",
      "or set KOED_REQUIRE_PYTHON_CHECKS=1/CI=true to make this a hard failure."
    ].join("\n")
  );
}

steps.push(["tests", "pnpm", ["test"]]);

for (const [label, command, args] of steps) {
  console.log(`\n> verify: ${label}`);
  const result = spawnSync(command, args, {
    stdio: "inherit"
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
