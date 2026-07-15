#!/usr/bin/env node
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
if (!Array.isArray(fixture.dbRequired) || fixture.dbRequired.length === 0) {
  throw new Error("PDS fixture must label DB-required coverage honestly.");
}
for (const scenario of requiredScenarios) {
  if (!fixture.scenarios?.includes(scenario)) {
    throw new Error(`PDS fixture is missing ${scenario}.`);
  }
}
for (const [key, value] of Object.entries(fixture.truth ?? {})) {
  if (value !== true) throw new Error(`PDS fixture truth ${key} must be true.`);
}
console.log(
  JSON.stringify({
    ok: true,
    suite: fixture.suite,
    scenarios: fixture.scenarios.length,
    dbRequired: fixture.dbRequired
  })
);
