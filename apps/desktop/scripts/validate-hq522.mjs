import process from "node:process";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const fixture = readFileSync(
  resolve(root, "apps/desktop/src/hq-522-usage-fixture.ts"),
  "utf8"
);
for (const variant of [
  "codexLowClaudeFine",
  "claudeLowCodexFine",
  "allFine",
  "noAlternative",
  "unknownAlternative",
  "staleAlternative",
  "passedResetAlternative",
  "restrictedAlternative",
  "secondBucketAlternative"
])
  assert.match(fixture, new RegExp(`\\b${variant}:`));
const result = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "apps/desktop/src/renderer/hq/usage/hq-usage-suggestion.test.ts",
    "apps/desktop/src/renderer/hq/usage/HqUsageSuggestion.test.tsx",
    "apps/desktop/src/renderer/hq/conversation/HqConversation.test.tsx"
  ],
  { cwd: root, env: process.env, stdio: "inherit" }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
