#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRootEnv } from "./api-token-bootstrap-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

loadRootEnv(root, process.env);

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    [
      "DATABASE_URL is required for `pnpm verify`.",
      "Full verification runs DB-backed tests and must not silently skip them.",
      "Run `pnpm env:setup` and start Postgres, or set DATABASE_URL explicitly."
    ].join("\n")
  );
  process.exit(2);
}

const steps = [
  ["lint", "pnpm", ["lint"]],
  ["db migration check", "pnpm", ["db:migrate:check"]],
  ["db migration smoke", "pnpm", ["db:migrate:smoke"]],
  ["typecheck", "pnpm", ["typecheck"]],
  ["test typecheck", "pnpm", ["typecheck:test"]]
];

steps.push([
  "tests",
  "node",
  ["packages/db/scripts/with-temp-db.mjs", "pnpm", "test"]
]);

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
