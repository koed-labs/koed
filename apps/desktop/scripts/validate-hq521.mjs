import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "../../..");
const fixture = readFileSync(
  resolve(root, "apps/desktop/src/renderer/hq/usage/hq-usage.fixture.ts"),
  "utf8"
);
for (const variant of [
  "codexLow",
  "claudeNear",
  "claudeAllowed",
  "allFine",
  "noAlternative",
  "stale",
  "passedReset",
  "secondCodexBucket",
  "codexRestriction",
  "unknown",
  "failedProbe",
  "oldAccountLate"
])
  assert.match(
    fixture,
    new RegExp(`\\b${variant}:`),
    `Missing usage fixture variant ${variant}`
  );

const result = spawnSync(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "apps/desktop/src/renderer/hq/usage/hq-usage-model.test.ts",
    "apps/desktop/src/renderer/hq/usage/HqUsageTable.test.tsx",
    "apps/desktop/src/renderer/hq/usage/HqUsageMenu.test.tsx",
    "apps/desktop/src/renderer/hq/settings/HqSettings.test.tsx",
    "apps/desktop/src/renderer/hq/conversation/HqConversation.test.tsx",
    "apps/desktop/src/renderer/hq/conversation/hq-conversation-model.test.ts"
  ],
  { cwd: root, env: process.env, stdio: "inherit" }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
