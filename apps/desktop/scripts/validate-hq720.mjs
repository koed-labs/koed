import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

// Data and command checks only. The full parity gate separately requires the
// real two-user N26 retained-summary/share-again proof and the HQ desktop chain.
const root = resolve(import.meta.dirname, "../../..");
assert.ok(
  process.env.DATABASE_URL,
  "HQ-720 validation requires an owned disposable PostgreSQL database."
);
const result = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "packages/db/src/project-share-policy-integration.test.ts",
    "packages/db/src/personal-project-share-policy-source-preparation.test.ts",
    "packages/db/tests/collaboration-shared-memory-authority-store.test.ts",
    "apps/api/src/local-edge/collaboration-shared-memory-control.test.ts",
    "apps/desktop/src/renderer/hq/HqSidebar.chat-sharing.test.tsx",
    "--maxWorkers=1",
    "--no-file-parallelism"
  ],
  { cwd: root, env: process.env, stdio: "inherit" }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
