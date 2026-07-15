#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const fixturePath = resolve(
  "packages/koed-server/test-fixtures/personal-device-sync-controls.json"
);
const requiredScenarios = [
  "two-device-offline-concurrent-capture",
  "two-order-convergence",
  "n-device-conflict-quarantine-and-resolution",
  "relay-replay-chunk-reorder-drop-and-duplicate",
  "relay-and-authority-outage",
  "membership-expiry",
  "key-rotation-and-revoked-member",
  "delayed-join-and-replacement-from-retained-replica",
  "lost-origin-and-recovery-loss",
  "tombstone-before-after-and-old-backup-restore",
  "perfect-clone-warning",
  "unknown-version-downgrade-tamper-and-cross-group",
  "no-team-api-token-path-vector-or-plaintext-leak"
];

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
if (fixture.mode !== "ci-safe-control-and-crypto") {
  throw new Error("PDS fixture mode must state its CI-safe boundary.");
}
if (!Array.isArray(fixture.coverageBoundary?.dbRequired)) {
  throw new Error("PDS fixture must label DB-required coverage honestly.");
}
const scenarios = new Map(
  (fixture.scenarioMatrix ?? []).map((scenario) => [scenario.id, scenario])
);
for (const scenario of requiredScenarios) {
  const coverage = scenarios.get(scenario)?.coverage;
  if (!coverage) throw new Error(`PDS fixture is missing ${scenario}.`);
  if (!["shared-crypto", "control-status", "db-required"].includes(coverage)) {
    throw new Error(
      `PDS fixture has invalid coverage boundary for ${scenario}.`
    );
  }
}
for (const [key, value] of Object.entries(fixture.truth ?? {})) {
  if (value !== true) throw new Error(`PDS fixture truth ${key} must be true.`);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const run = (filter, testFiles) =>
  execFileSync(
    pnpm,
    ["--filter", filter, "exec", "vitest", "run", ...testFiles],
    {
      cwd: process.cwd(),
      stdio: "inherit"
    }
  );

// Fixed shared vectors exercise actual protocol crypto; control tests exercise
// encrypted recovery and lifecycle behavior. DB-required rows remain declared,
// not falsely represented as in-process relay or Projection coverage.
run("@koed/shared", [
  "src/personal-device-sync-v1-fixture.test.ts",
  "src/personal-device-sync.test.ts"
]);
run("@koed/koed-server", ["src/personal-sync.test.ts"]);

console.log(
  JSON.stringify({
    ok: true,
    suite: fixture.suite,
    scenarios: fixture.scenarioMatrix.length,
    dbRequired: fixture.coverageBoundary.dbRequired
  })
);
