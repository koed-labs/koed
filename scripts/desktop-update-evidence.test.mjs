import assert from "node:assert/strict";
import test from "node:test";
import { validateDesktopUpdateEvidence } from "./desktop-update-evidence-lib.mjs";

const hash = "a".repeat(64);
const valid = () => ({
  task_id: "desktop-update-e2e",
  generated_at: new Date().toISOString(),
  evidence_mode: "fresh_for_this_snapshot",
  versions: { n_minus_1: "0.4.3", n: "0.4.4" },
  artifacts: [
    {
      kind: "n_minus_1",
      version: "0.4.3",
      path: "/tmp/0.4.3.zip",
      sha256: hash
    },
    { kind: "n", version: "0.4.4", path: "/tmp/0.4.4.zip", sha256: hash }
  ],
  feed_validation: { ok: true, feed_url: "http://127.0.0.1:1234/stable/" },
  steps: [
    "feed_validation",
    "no_automatic_download",
    "manual_check",
    "user_download",
    "restart_install",
    "relaunch_version",
    "shutdown_order",
    "data_preservation"
  ].map((name) => ({ name, ok: true })),
  action_timeline: [
    { action: "launch_n_minus_1", version: "0.4.3" },
    { action: "automatic_check_window" },
    { action: "manual_check" },
    { action: "user_download" },
    { action: "download_ready" },
    { action: "restart_install" },
    { action: "relaunch", version: "0.4.4" }
  ],
  shutdown: {
    updater_driven: true,
    app_process_exited: true,
    service_pids_stopped: true,
    service_pids_before_install: { api: 1234 }
  },
  before_inventory: [{ path: "config/server.json", size: 3, sha256: hash }],
  after_inventory: [{ path: "config/server.json", size: 3, sha256: hash }],
  data_preservation: {
    ok: true,
    queries: [
      {
        endpoint: "/v1/memory/graph/events",
        rows: 1,
        status: 200,
        sentinelPresent: true
      },
      {
        endpoint: "/v1/memory/graph/events",
        rows: 1,
        status: 200,
        sentinelPresent: true
      }
    ],
    sentinels: {
      config: hash,
      api_token_reference: hash,
      model: hash,
      data: hash
    }
  },
  relaunch: { reported_version: "0.4.4" }
});

test("accepts complete fresh N-1 to N evidence", () => {
  assert.deepEqual(validateDesktopUpdateEvidence(valid()).ok, true);
});

test("rejects missing required evidence step", () => {
  const manifest = valid();
  manifest.steps = manifest.steps.filter(
    (step) => step.name !== "shutdown_order"
  );
  assert.throws(
    () => validateDesktopUpdateEvidence(manifest),
    /Missing required evidence step shutdown_order/
  );
});

test("rejects tampered artifact hash", () => {
  const manifest = valid();
  manifest.artifacts[1].sha256 = "not-a-hash";
  assert.throws(
    () => validateDesktopUpdateEvidence(manifest),
    /artifacts\[1\]\.sha256/
  );
});

test("rejects missing or mismatched shutdown PID proof", () => {
  const manifest = valid();
  manifest.shutdown.service_pids_before_install = {};
  assert.throws(
    () => validateDesktopUpdateEvidence(manifest),
    /service_pids_before_install/
  );
});

test("rejects mismatched action and query proof", () => {
  const manifest = valid();
  manifest.action_timeline.at(-1).version = "0.4.3";
  assert.throws(
    () => validateDesktopUpdateEvidence(manifest),
    /relaunch action version/
  );
  const queryManifest = valid();
  queryManifest.data_preservation.queries[1].sentinelPresent = false;
  assert.throws(
    () => validateDesktopUpdateEvidence(queryManifest),
    /successful sentinel query/
  );
});
