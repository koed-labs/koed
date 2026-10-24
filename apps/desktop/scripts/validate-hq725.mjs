import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
assert.ok(
  process.env.KOED_HQ504_TEST_DATABASE_URL,
  "Set the owned text-action test database prerequisite."
);
for (const [command, args] of [
  [process.execPath, ["apps/desktop/scripts/validate-hq725-help.mjs"]],
  [
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "packages/shared/src/sharing-help.test.ts",
      "packages/mcp-server/src/sharing-overview-tool.test.ts",
      "packages/mcp-server/tests/pi-extension.test.ts",
      "packages/mcp-server/tests/pi-managed-conversation.test.ts",
      "packages/db/src/managed-text-action-repository.pg.test.ts",
      "apps/api/src/local-edge/sharing-routes.test.ts",
      "apps/api/src/local-edge/sharing-removal-authority.test.ts",
      "apps/desktop/src/renderer/hq/sharing/sharing-text-removal.test.ts",
      "--maxWorkers=1",
      "--no-file-parallelism"
    ]
  ]
]) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
