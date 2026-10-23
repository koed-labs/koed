import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const databaseUrl =
  process.env.KOED_HQ721_TEST_DATABASE_URL ??
  process.env.KOED_HQ713_TEST_DATABASE_URL ??
  process.env.DATABASE_URL;
assert.ok(databaseUrl, "HQ-721 requires an owned PostgreSQL test database");
assert.ok(
  ["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol),
  "HQ-721 requires PostgreSQL"
);
const env = {
  ...process.env,
  KOED_HQ721_TEST_DATABASE_URL: databaseUrl
};
const run = (cwd, ...args) => {
  const result = spawnSync("pnpm", args, {
    cwd: resolve(root, cwd),
    env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `HQ-721 validation failed: ${args.join(" ")}`);
};

// Compile current sources before readers; the Vitest runs do not emit.
for (const name of ["@koed/shared", "@koed/db", "@koed/api"])
  run(".", "--filter", name, "build");
run(
  "packages/db",
  "exec",
  "vitest",
  "run",
  "src/personal-share-origin-repository.pg.test.ts",
  "--no-file-parallelism"
);
run(
  "apps/api",
  "exec",
  "vitest",
  "run",
  "src/team/lifecycle-routes.test.ts",
  "src/local-edge/collaboration-team-control.test.ts",
  "--no-file-parallelism"
);
process.stdout.write(
  "PASS HQ721.data: typed Personal Share Origin, Team actor/mode, accepted-invite access version and API boundary.\n"
);
