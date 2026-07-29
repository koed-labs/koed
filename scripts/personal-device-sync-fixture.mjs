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
const scenarios = new Map(
  (fixture.scenarioMatrix ?? []).map((scenario) => [scenario.id, scenario])
);
for (const scenario of requiredScenarios) {
  if (scenarios.get(scenario)?.coverage !== "executed") {
    throw new Error(`PDS fixture must execute ${scenario}.`);
  }
}
if (!Array.isArray(fixture.coverageBoundary?.optionalDb)) {
  throw new Error("PDS fixture must state optional DB coverage.");
}
for (const [key, value] of Object.entries(fixture.truth ?? {})) {
  if (value !== true) throw new Error(`PDS fixture truth ${key} must be true.`);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const run = (filter, testFiles, extra = []) =>
  execFileSync(
    pnpm,
    ["--filter", filter, "exec", "vitest", "run", ...testFiles, ...extra],
    {
      cwd: process.cwd(),
      stdio: "inherit"
    }
  );

// New simulation uses shared production protocol verification/signing/package APIs.
run("@koed/shared", [
  "src/personal-device-sync-adversarial-fixture.test.ts",
  "src/personal-device-sync-v1-fixture.test.ts",
  "src/personal-device-session-package.test.ts",
  "src/personal-device-sync-relay.test.ts"
]);
run("@koed/koed-server", ["src/personal-sync.test.ts"]);
run("@koed/api", [
  "src/personal-device-sync/local-source.test.ts",
  "src/personal-device-sync/relay-routes.test.ts",
  "src/personal-device-sync/secure-runtime.test.ts"
]);
run("@koed/worker", ["src/personal-device-sync-runtime.test.ts"]);

let dbStage = {
  state: "skipped",
  missingPrerequisite: "DATABASE_URL"
};
if (process.env.DATABASE_URL?.trim()) {
  execFileSync(pnpm, ["--filter", "@koed/db", "migrate:up"], {
    cwd: process.cwd(),
    stdio: "inherit"
  });
  run(
    "@koed/db",
    ["tests/repository.test.ts"],
    [
      "-t",
      "runs Personal Device relay cleanup against PostgreSQL|seals a closed PDS replica agent bundle for local projection"
    ]
  );
  run(
    "@koed/db",
    ["tests/historical-import-repository.test.ts"],
    ["-t", "claims a newly appended segment for an enabled Personal replica"]
  );
  run("@koed/worker", ["src/raw-projection-service.test.ts"]);
  dbStage = { state: "executed" };
}

console.log(
  JSON.stringify({
    ok: true,
    suite: fixture.suite,
    scenarios: requiredScenarios,
    dbStage
  })
);
