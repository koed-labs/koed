import process from "node:process";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const result = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "apps/desktop/src/renderer/hq/sharing",
    "apps/desktop/src/renderer/hq/HqSidebar.test.tsx",
    "apps/desktop/src/renderer/hq/settings/HqSettings.test.tsx",
    "apps/desktop/src/renderer/hq/share-project/HqShareSheet.test.tsx",
    "--maxWorkers=1",
    "--no-file-parallelism"
  ],
  { cwd: root, env: process.env, stdio: "inherit" }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
