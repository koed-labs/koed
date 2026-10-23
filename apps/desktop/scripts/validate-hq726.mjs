import process from "node:process";
import { URL } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const databaseUrl = process.env.KOED_HQ713_TEST_DATABASE_URL;
assert.ok(databaseUrl, "HQ-726 needs an owned two-user PostgreSQL lane");
assert.ok(
  ["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol),
  "HQ-726 needs PostgreSQL"
);
const env = {
  ...process.env,
  KOED_HQ712_GRANT_TEST_DATABASE_URL:
    process.env.KOED_HQ712_GRANT_TEST_DATABASE_URL ?? databaseUrl
};
const run = (...args) => {
  const result = spawnSync("pnpm", args, {
    cwd: root,
    env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `HQ-726 check failed: ${args.join(" ")}`);
};

run(
  "--filter",
  "@koed/db",
  "exec",
  "vitest",
  "run",
  "src/workspace-project-grant-lifecycle.test.ts",
  "--no-file-parallelism"
);
run(
  "--filter",
  "@koed/api",
  "exec",
  "vitest",
  "run",
  "src/high-risk/approval-policy.test.ts",
  "src/shared-memory/routes.test.ts",
  "src/team/workspace-project-contributions-routes.test.ts",
  "--no-file-parallelism"
);
run(
  "--filter",
  "@koed/desktop",
  "exec",
  "vitest",
  "run",
  "src/renderer/hq/memory/WhatKoedKnows.test.tsx",
  "src/koed-server/curated-memory-client.test.ts",
  "--no-file-parallelism"
);
run("test:hq-two-user");
process.stdout.write(
  "PASS HQ-726: Project contribution lifecycle and HQ attribution.\n"
);
