import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertDisposableMultiDeviceRoot,
  prepareMultiDeviceProfiles,
  setEnvValue
} from "./multi-device-profile-lib.mjs";

test("profile environment overrides are exact and idempotent", () => {
  assert.equal(
    setEnvValue(
      "DATABASE_URL=test\nWORK_QUEUE_BACKEND=bullmq\n",
      "WORK_QUEUE_BACKEND",
      "local"
    ),
    "DATABASE_URL=test\nWORK_QUEUE_BACKEND=local\n"
  );
  assert.equal(
    setEnvValue("DATABASE_URL=test\n", "WORK_QUEUE_BACKEND", "local"),
    "DATABASE_URL=test\nWORK_QUEUE_BACKEND=local\n"
  );
});

test("profile preparation creates isolated Koed, Codex, and Electron homes", () => {
  const parent = mkdtempSync(resolve(tmpdir(), "koed-profile-test-"));
  const root = resolve(parent, "koed-multi-device-fixture");
  const spawn = (_command, _args, options) => {
    writeFileSync(options.env.KOED_ENV_PATH, "DATABASE_URL=test\n", {
      mode: 0o600
    });
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    const result = prepareMultiDeviceProfiles({ root, spawn });
    const [deviceA, deviceB] = result.devices;
    assert.notEqual(deviceA.koedHome, deviceB.koedHome);
    assert.notEqual(deviceA.codexHome, deviceB.codexHome);
    assert.notEqual(deviceA.codexConfigPath, deviceB.codexConfigPath);
    assert.notEqual(deviceA.electronUserData, deviceB.electronUserData);
    assert.deepEqual([deviceA.cdpPort, deviceB.cdpPort], [9224, 9225]);
    assert.match(
      readFileSync(deviceA.envPath, "utf8"),
      /^WORK_QUEUE_BACKEND=local$/m
    );
    assert.match(
      readFileSync(deviceB.envPath, "utf8"),
      /^WORK_QUEUE_BACKEND=local$/m
    );
    assert.match(
      readFileSync(deviceA.envPath, "utf8"),
      new RegExp(
        `^CODEX_CONFIG_PATH=${deviceA.codexConfigPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "m"
      )
    );
    assert.match(
      readFileSync(deviceB.envPath, "utf8"),
      new RegExp(
        `^CODEX_CONFIG_PATH=${deviceB.codexConfigPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "m"
      )
    );
    assert.equal(
      JSON.parse(readFileSync(result.manifestPath, "utf8")).version,
      1
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("profile preparation refuses non-temporary and accidental replacement roots", () => {
  assert.throws(
    () => assertDisposableMultiDeviceRoot("/home/test/koed-multi-device-run"),
    /OS temporary directory/
  );
  const parent = mkdtempSync(resolve(tmpdir(), "koed-profile-test-"));
  const root = resolve(parent, "koed-multi-device-existing");
  try {
    prepareMultiDeviceProfiles({
      root,
      spawn: (_command, _args, options) => {
        writeFileSync(options.env.KOED_ENV_PATH, "DATABASE_URL=test\n");
        return { status: 0, stdout: "", stderr: "" };
      }
    });
    assert.throws(
      () => prepareMultiDeviceProfiles({ root, spawn: () => ({ status: 0 }) }),
      /already exists/
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
